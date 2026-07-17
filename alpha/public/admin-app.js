const tokenKey = "insole_mes_alpha_token_admin";
const mobileTokenKey = "insole_mes_alpha_token_mobile";

import {
  getDueDateRisk,
  getProcessProgressSummary,
  getReportCompletedQty,
  getWorkOrderQualitySummary as calculateWorkOrderQuality,
  matchesWorkOrderFilter,
} from "./production-metrics.js";

const defaultRoute = [
  { name: "备料", status: "待开始" },
  { name: "裁切 / 开料", status: "待开始" },
  { name: "成型 / 压制", status: "待开始" },
  { name: "修边", status: "待开始" },
  { name: "检验", status: "待开始" },
  { name: "包装 / 入库", status: "待开始" },
];

const sampleStatuses = ["待打样", "打样中", "待确认", "已确认", "暂停"];
const orderStatuses = ["待领料", "待开始", "生产中", "已暂停", "已完成"];
const priorities = ["高", "中", "低"];
const orderFilterDefinitions = [
  { key: "all", label: "全部" },
  { key: "not-started", label: "未开始" },
  { key: "in-progress", label: "进行中" },
  { key: "completed", label: "已完成" },
  { key: "urgent", label: "加急" },
  { key: "overdue", label: "逾期" },
  { key: "due-soon", label: "未来 3 天到期" },
  { key: "risk", label: "异常 / 风险" },
];
const activityPageSize = 5;
const orderPageSize = 3;
const batchPageSize = 5;
const movementPageSize = 4;
const AUTO_REFRESH_INTERVAL_MS = 5000;

const state = {
  currentView: "dashboard",
  selectedSampleId: "",
  selectedOrderId: "",
  selectedMaterialCode: "",
  selectedMaterialKey: "",
  sampleEditorMode: "edit",
  orderEditorMode: "edit",
  materialEditorMode: "edit",
  workOrderIssueFormOpen: false,
  workOrderIssueDraft: {
    materialCode: "",
    batchNo: "",
    qty: "1",
  },
  orderFocusMode: false,
  orderDrawerMode: "detail",
  orderFormDirty: false,
  orderFormInitialSnapshot: "",
  orderSaving: false,
  orderScrollLocked: false,
  orderListScrollY: 0,
  orderBeforeCreateId: "",
  activityPage: 1,
  orderPage: 1,
  batchPage: 1,
  movementPage: 1,
  orderFilter: "all",
  materialFilter: "all",
  batchFilter: "all",
  materialDrawerMode: "",
  materialDrawerDirty: false,
  materialDrawerInitialSnapshot: "",
  materialDrawerSaving: false,
  materialDrawerMaterialCode: "",
  materialTraceOpen: false,
  materialTraceBatchId: "",
  materialTraceData: null,
  materialTraceLoading: false,
  materialTraceError: "",
  materialTraceRequestVersion: 0,
  materialTraceExpandedWorkOrders: {},
  materialTraceView: "trace",
  materialTraceReturnOrderId: "",
  materialTraceScrollTop: 0,
  materialMovementDirty: false,
  materialItemEditDirty: false,
  workOrderIssueDirty: false,
  autoRefreshTimer: null,
  isAutoRefreshing: false,
  pendingAutoRefresh: false,
  lastUpdatedAt: null,
  autoRefreshFailed: false,
  movementNewHint: false,
  batchPinnedKey: "",
  deepLinkApplied: false,
  interactionPauseUntil: 0,
  currentUser: null,
  data: null,
};

function getPaginationModel(totalItems, pageSize, requestedPage) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(Math.max(1, Number(requestedPage || 1)), totalPages);
  const start = (page - 1) * pageSize;
  const pages = totalPages <= 7
    ? Array.from({ length: totalPages }, (_, index) => index + 1)
    : Array.from(new Set([1, page - 1, page, page + 1, totalPages].filter((item) => item >= 1 && item <= totalPages))).sort((a, b) => a - b);
  return { page, totalPages, start, end: start + pageSize, pages, visible: totalItems > pageSize };
}

function renderPaginationHtml(key, totalItems, model) {
  if (!model.visible) return "";
  let previous = 0;
  const pageButtons = model.pages.map((page) => {
    const gap = previous && page - previous > 1 ? '<span class="pagination-ellipsis">…</span>' : "";
    previous = page;
    return `${gap}<button class="pagination-page ${page === model.page ? "active" : ""}" type="button" data-pagination-key="${key}" data-page="${page}" aria-label="第 ${page} 页">${page}</button>`;
  }).join("");
  return `
    <div class="light-pagination" data-pagination="${key}">
      <span>共 ${totalItems} 条</span>
      <span>第 ${model.page} / ${model.totalPages} 页</span>
      <button class="ghost-btn slim-btn" type="button" data-pagination-key="${key}" data-page="${model.page - 1}" ${model.page <= 1 ? "disabled" : ""}>上一页</button>
      <div class="pagination-pages">${pageButtons}</div>
      <button class="ghost-btn slim-btn" type="button" data-pagination-key="${key}" data-page="${model.page + 1}" ${model.page >= model.totalPages ? "disabled" : ""}>下一页</button>
    </div>
  `;
}

function bindPagination(root, key, onPage) {
  root?.querySelectorAll(`[data-pagination-key="${key}"]`).forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      onPage(Number(button.getAttribute("data-page") || 1));
    });
  });
}

const views = {
  dashboard: { title: "总览", subtitle: "先把样品、生产单、批次物料和每一步进度抓在手里。" },
  samples: { title: "样品单", subtitle: "用样品单承接打样版本、负责人和客户确认。" },
  orders: { title: "生产单", subtitle: "以生产单为中心，把领料、工序、检验和入库串起来。" },
  materials: { title: "物料库存", subtitle: "重点看批次、保质期、安全库存和缺料风险。" },
  reporting: { title: "报工台", subtitle: "V1 先按工序报工，手机端提交后回流到这里。" },
  alerts: { title: "预警中心", subtitle: "优先盯缺料、临期批次、延期和暂停异常。" },
};

const roleLabels = {
  manager: "管理端",
  worker: "工人",
  warehouse: "仓库",
};

const materialFilterDefinitions = [
  { key: "all", label: "全部" },
  { key: "low", label: "低库存" },
  { key: "soon", label: "即将过期" },
  { key: "expired", label: "已过期" },
  { key: "used-up", label: "已用完" },
];

function token() {
  return localStorage.getItem(tokenKey);
}

function clearToken() {
  localStorage.removeItem(tokenKey);
}

function handoffToMobile(tokenValue) {
  if (tokenValue) {
    localStorage.setItem(mobileTokenKey, tokenValue);
  }
  clearToken();
  window.location.replace("./mobile.html");
}

function ensureManagerSession(user, tokenValue = token()) {
  if (!user || user.role === "manager") return true;
  handoffToMobile(tokenValue);
  return false;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token() ? { authorization: `Bearer ${token()}` } : {}),
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : { message: await response.text() };
  if (!response.ok) {
    if (path.startsWith("/api/") && /^not found$/i.test(String(payload.message || "").trim())) {
      throw new Error("接口未加载，请先停止旧的 npm 服务，再重新运行 npm.cmd start");
    }
    throw new Error(payload.message || "请求失败");
  }
  return payload;
}

function setLoggedIn(value) {
  document.getElementById("login-screen").classList.toggle("hidden", value);
  document.getElementById("app-shell").classList.toggle("hidden", !value);
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 1800);
}

function renderUser() {
  const user = state.currentUser;
  document.getElementById("current-user").textContent = user ? `${user.name} · ${roleLabels[user.role] || user.role}` : "未登录";
}

function disableBrowserSuggestions(scope = document) {
  scope.querySelectorAll("form").forEach((form) => form.setAttribute("autocomplete", "off"));
  scope.querySelectorAll("input, textarea").forEach((field) => {
    field.setAttribute("autocomplete", "off");
    field.setAttribute("autocorrect", "off");
    field.setAttribute("autocapitalize", "off");
    field.setAttribute("spellcheck", "false");
  });
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function normalizeStatus(status) {
  if (status === "生产中" || status === "进行中" || status === "已确认") return "running";
  if (status === "待领料" || status === "待开始" || status === "待确认" || status === "待打样" || status === "打样中") return "pending";
  if (status === "high" || status === "延期" || status === "低库存" || status === "已暂停" || status === "暂停") return "warn";
  return "";
}

function formatShortDate(value) {
  return value ? String(value).slice(5, 10) : "-";
}

function isNumericText(value) {
  return /^\d+(\.\d+)?$/.test(String(value || "").trim());
}

function materialUnitLabel(material) {
  const unit = String(material?.unit || "kg").trim();
  return unit && !isNumericText(unit) ? unit : "kg";
}

function percent(doneQty, plannedQty) {
  if (!plannedQty) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(doneQty) / Number(plannedQty)) * 100)));
}

function getWorkOrderReports(orderId) {
  return (state.data?.reports || []).filter((report) => report.workOrderId === orderId);
}

function getWorkOrderMaterialIssues(orderId) {
  return (state.data?.workOrderMaterialIssues || []).filter((issue) => issue.workOrderId === orderId);
}

function getWorkOrderQualitySummary(order) {
  return calculateWorkOrderQuality(order, state.data?.reports || []);
}

function getOrderDisplayStatus(order, quality = getWorkOrderQualitySummary(order)) {
  return quality.hasFinalShortage ? "已完成，有短缺" : order.status || "未设置状态";
}

function matchesOrderFilter(order, filterKey) {
  return matchesWorkOrderFilter(order, filterKey, state.data?.reports || [], state.data?.alerts || []);
}

function renderDueDateBadge(order) {
  const risk = getDueDateRisk(order);
  return `<span class="due-badge ${risk.key}">${escapeHtml(risk.label)}</span>`;
}

function renderQualityBadge(order) {
  const quality = getWorkOrderQualitySummary(order);
  const badRate = quality.badRate === null ? "暂无" : `${quality.badRate.toFixed(1)}%`;
  const className = quality.badQty > 0 || quality.hasFinalShortage ? "quality-badge risk" : "quality-badge";
  return `<span class="${className}">成品 ${quality.finishedGoodQty} · 可流转 ${quality.currentTransferableGoodQty} · 累计不良 ${quality.badQty} · ${badRate}</span>`;
}

function renderProcessProgress(order, compact = false) {
  const progress = getProcessProgressSummary(order);
  if (!progress.total) return '<div class="process-empty">未配置工序</div>';
  const reports = getWorkOrderReports(order.id);
  return `
    <div class="process-progress ${compact ? "compact" : ""}">
      <div class="process-progress-head">
        <span>${progress.completed}/${progress.total} 道已完成</span>
        <span>${progress.percent}%</span>
      </div>
      <div class="process-track" role="list" aria-label="${escapeHtml(order.id)} 工序进度">
        ${progress.route
          .map((step, index) => {
            const hasRisk = reports.some((report) => report.processName === step.name && Number(report.badQty || 0) > 0);
            const statusClass =
              step.status === "已完成"
                ? "completed"
                : step.status === "进行中" || step.name === order.currentProcess || index === progress.currentIndex
                  ? "active"
                  : "pending";
            return `
              <div class="process-node ${statusClass}" role="listitem" title="${escapeHtml(step.status || "待开始")}">
                <span class="process-dot">${step.status === "已完成" ? "✓" : index + 1}</span>
                <span class="process-name">${escapeHtml(step.name || "未命名工序")}</span>
                ${hasRisk ? '<span class="risk-dot" aria-label="该工序有不良记录"></span>' : ""}
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function formatDateTime(value) {
  if (!value) return "历史数据 / 无时间记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function fileDateStamp() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function csvCell(value) {
  const text = value === null || value === undefined || value === "" ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(filename, headers, rows) {
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(link.href);
  link.remove();
}

function formatTraceQuantity(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return String(value ?? "");
  return number.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 12 });
}

function traceStatusLabel(status) {
  if (status === "active") return "当前有效";
  if (status === "corrected") return "已冲正";
  return "状态待核验";
}

function traceStatusClass(status) {
  if (status === "active") return "running";
  if (status === "corrected") return "warn";
  return "pending";
}

function traceIssueRows(trace) {
  if (Array.isArray(trace?.issues)) return trace.issues;
  return (trace?.workOrders || []).flatMap((item) => item.issues || []);
}

function renderTraceMovementDetails(label, movement) {
  if (!movement) return `<div class="trace-movement-missing">${escapeHtml(label)}：缺失</div>`;
  return `
    <div class="trace-movement-details">
      <strong>${escapeHtml(label)}：${escapeHtml(movement.id || "-")}</strong>
      <span>类型 ${escapeHtml(movementTypeLabel(movement.type))} / 数量 ${escapeHtml(formatTraceQuantity(movement.qty))} / 时间 ${escapeHtml(formatDateTime(movement.createdAt))}</span>
      <span>库位 ${escapeHtml(movement.location || "-")} / 操作人 ${escapeHtml(movement.operator || "-")} / 来源 ${escapeHtml(movement.source || "-")}</span>
      <span>前后库存 ${escapeHtml(movement.beforeQty ?? "-")} → ${escapeHtml(movement.afterQty ?? "-")} / 备注 ${escapeHtml(movement.note || "无")}</span>
    </div>
  `;
}

function renderMaterialTraceIssue(issue, unit) {
  const fefoText = issue.isFefoRecommended ? "符合 FEFO" : issue.recommendedBatchNo ? `推荐批次：${issue.recommendedBatchNo}` : "未记录 FEFO 推荐";
  const reasons = [
    fefoText,
    issue.overrideReason ? `强制原因：${issue.overrideReason}` : "",
    issue.note ? `备注：${issue.note}` : "",
    issue.correctionReason ? `冲正原因：${issue.correctionReason}` : "",
  ].filter(Boolean).join("；");
  return `
    <details class="trace-issue-detail">
      <summary>
        <span><strong>${escapeHtml(formatTraceQuantity(issue.qty))}${escapeHtml(unit)}</strong> · ${escapeHtml(formatDateTime(issue.createdAt))}</span>
        <span class="status ${traceStatusClass(issue.status)}">${escapeHtml(traceStatusLabel(issue.status))}</span>
      </summary>
      <div class="trace-issue-detail-body">
        <div class="item-meta">操作人：${escapeHtml(issue.operator || "-")} / 库位：${escapeHtml(issue.location || "-")} / 原领料流水：${escapeHtml(issue.stockMovementId || "-")}</div>
        <div class="item-note">${escapeHtml(reasons || "无备注")}</div>
        ${renderTraceMovementDetails("原始流水", issue.originalMovement || issue.stockMovement)}
        ${renderTraceMovementDetails("冲正流水", issue.correctionMovement)}
      </div>
    </details>
  `;
}

function renderMaterialTraceView() {
  const trace = state.materialTraceData;
  if (!trace) {
    return state.materialTraceLoading
      ? '<div class="empty-state trace-loading">正在加载批次追溯…</div>'
      : `<div class="empty-state">${escapeHtml(state.materialTraceError || "暂无追溯数据")}</div>`;
  }
  const batch = trace.batch || {};
  const material = trace.material || {};
  const summary = trace.summary || {};
  const unit = materialUnitLabel(material.code ? material : batch);
  const workOrders = trace.workOrders || [];
  const batchStatus = getBatchStatus(batch);
  const unknownText = Number(summary.unknownIssueCount || 0)
    ? `${summary.unknownIssueCount} 笔 / ${summary.unknownWorkOrderCount || 0} 个工单 / ${formatTraceQuantity(summary.unknownQty)}${unit}`
    : "无待核验记录";

  return `
    <div class="detail-stack material-trace-view">
      <div class="detail-block trace-overview-card">
        <div class="panel-head">
          <div>
            <div class="detail-title">批次概览</div>
            <h2>${escapeHtml(material.name || batch.materialCode || "物料批次")} / ${escapeHtml(batch.batchNo || "-")}</h2>
          </div>
          <span class="status ${batchStatusClass(batchStatus)}">${escapeHtml(batchStatus)}</span>
        </div>
        <div class="item-meta">物料编号：${escapeHtml(batch.materialCode || "-")} / 库位：${escapeHtml(batch.location || "-")} / 单位：${escapeHtml(unit)}</div>
        <div class="item-meta">初始数量：${escapeHtml(formatTraceQuantity(batch.initialQty))}${escapeHtml(unit)} / 当前库存：${escapeHtml(formatTraceQuantity(batch.stockQty))}${escapeHtml(unit)} / 到期：${escapeHtml(String(batch.expiryDate || "").slice(0, 10) || "-")}</div>
      </div>

      <div class="execution-kpis trace-kpis">
        <div><span>历史领料次数</span><strong>${Number(summary.historicalIssueCount || 0)}</strong></div>
        <div><span>历史关联工单数</span><strong>${Number(summary.historicalWorkOrderCount || 0)}</strong></div>
        <div><span>当前有效工单数</span><strong>${Number(summary.activeWorkOrderCount || 0)}</strong></div>
        <div><span>历史领料总量</span><strong>${escapeHtml(formatTraceQuantity(summary.historicalQty))}${escapeHtml(unit)}</strong></div>
        <div><span>有效净领料数量</span><strong>${escapeHtml(formatTraceQuantity(summary.effectiveNetQty))}${escapeHtml(unit)}</strong></div>
        <div><span>待核验记录</span><strong>${Number(summary.unknownIssueCount || 0)}</strong></div>
      </div>

      <div class="detail-block trace-verification-block">
        <div class="panel-head">
          <h2>待核验信息</h2>
          <span class="status ${Number(summary.unknownIssueCount || 0) ? "pending" : "running"}">${Number(summary.unknownIssueCount || 0) ? "需要核对" : "已确认"}</span>
        </div>
        <div class="item-note">${escapeHtml(unknownText)}</div>
        <div class="item-note">已冲正数量仍计入历史总量，但不计入有效净领料；待核验数量不计入有效统计。</div>
      </div>

      <div class="detail-block">
        <div class="panel-head">
          <div>
            <h2>按工单汇总的领料结果</h2>
            <div class="item-note">工单按最近领料时间倒序，明细按领料时间倒序。</div>
          </div>
          <button class="ghost-btn slim-btn" type="button" data-trace-export>导出追溯</button>
        </div>
        <div class="trace-work-order-list">
          ${workOrders.length
            ? workOrders
                .map((group) => {
                  const expanded = state.materialTraceExpandedWorkOrders[group.workOrderId] === true;
                  const orderTitle = group.workOrder?.product ? ` · ${group.workOrder.product}` : "";
                  return `
                    <section class="trace-work-order-card ${expanded ? "expanded" : ""}">
                      <div class="trace-work-order-head">
                        <div>
                          ${group.workOrderId
                            ? `<button class="trace-work-order-link" type="button" data-trace-order-id="${escapeHtml(group.workOrderId)}">${escapeHtml(group.workOrderId)}</button>`
                            : `<strong>工单待核验</strong>`}
                          <span class="item-meta">${escapeHtml(orderTitle.replace(/^ · /, ""))}</span>
                        </div>
                        <span class="status ${traceStatusClass(group.status)}">${escapeHtml(group.statusLabel || traceStatusLabel(group.status))}</span>
                      </div>
                      <div class="trace-work-order-metrics">
                        <span>历史 ${escapeHtml(formatTraceQuantity(group.historicalQty))}${escapeHtml(unit)}</span>
                        <span>有效 ${escapeHtml(formatTraceQuantity(group.effectiveNetQty))}${escapeHtml(unit)}</span>
                        <span>已冲正 ${escapeHtml(formatTraceQuantity(group.correctedQty))}${escapeHtml(unit)}</span>
                        <span>待核验 ${escapeHtml(formatTraceQuantity(group.unknownQty))}${escapeHtml(unit)}</span>
                        <span>${Number(group.issueCount || 0)} 笔</span>
                      </div>
                      <button class="ghost-btn slim-btn trace-expand-btn" type="button" data-trace-toggle="${escapeHtml(group.workOrderId)}">${expanded ? "收起明细" : "展开明细"}</button>
                      ${expanded ? `<div class="trace-issue-list">${(group.issues || []).map((issue) => renderMaterialTraceIssue(issue, unit)).join("")}</div>` : ""}
                    </section>
                  `;
                })
                .join("")
            : '<div class="empty-state">该批次暂无工单领料记录。</div>'}
        </div>
      </div>
      ${state.materialTraceLoading ? '<div class="item-note trace-refreshing">正在静默更新追溯数据…</div>' : ""}
    </div>
  `;
}

function movementTypeLabel(type) {
  return type === "out" ? "出库" : "入库";
}

function movementStatusLabel(item) {
  if (item.correctionOfMovementId) return "冲正流水";
  if (item.correctedByMovementId) return "已冲正";
  return "正常流水";
}

function movementStatusClass(item) {
  if (item.correctionOfMovementId) return "pending";
  if (item.correctedByMovementId) return "warn";
  return "";
}

function movementReason(item) {
  if (item.correctionReason) return item.correctionReason;
  const matched = String(item.note || "").match(/FEFO原因[:：]([^；]+)/);
  return matched ? matched[1].trim() : "";
}

function renderWorkOrderReportHistory(order) {
  const reports = getWorkOrderReports(order.id);
  if (!reports.length) return '<div class="empty-state compact-empty">暂无报工记录，手机端提交后会出现在这里。</div>';
  return `
    <div class="report-history" role="table" aria-label="${escapeHtml(order.id)} 报工记录">
      <div class="report-history-row head" role="row">
        <span>工序 / 人员</span><span>完成</span><span>良品</span><span>不良</span><span>不良原因 / 备注</span><span>时间</span>
      </div>
      ${reports
        .map(
          (report) => `
            <div class="report-history-row" role="row">
              <span><strong>${escapeHtml(report.processName || "未填写工序")}</strong><small>${escapeHtml(report.operator || "未知人员")}</small></span>
              <span>${getReportCompletedQty(report)}</span>
              <span>${Number(report.goodQty || 0)}</span>
              <span class="${Number(report.badQty || 0) > 0 ? "danger-text" : ""}">${Number(report.badQty || 0)}</span>
              <span title="${escapeHtml([report.badReason, report.note].filter(Boolean).join("；") || "无")}">${escapeHtml([report.badReason, report.note].filter(Boolean).join("；") || "无")}</span>
              <span>${escapeHtml(formatDateTime(report.createdAt))}</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function getWorkOrderIssueFormContext() {
  const materialItems = getMaterialItems().filter((item) => item.status !== "停用");
  const draft = state.workOrderIssueDraft || {};
  const materialCode = materialItems.some((item) => item.code === draft.materialCode)
    ? draft.materialCode
    : materialItems[0]?.code || "";
  const material = materialItems.find((item) => item.code === materialCode) || null;
  const batches = getMaterialBatches().filter((batch) => batch.materialCode === materialCode && Number(batch.stockQty || 0) > 0);
  const qty = Number(draft.qty || 0) > 0 ? Number(draft.qty) : 1;
  const plan = material ? buildLocalFefoPlan(materialCode, qty) : { recommendedBatch: null };
  const batchNo = batches.some((batch) => batch.batchNo === draft.batchNo)
    ? draft.batchNo
    : plan.recommendedBatch?.batchNo || batches[0]?.batchNo || "";
  const batch = batches.find((item) => item.batchNo === batchNo) || null;
  return { materialItems, materialCode, material, batches, batchNo, batch, qty };
}

function renderWorkOrderMaterialIssueHistory(order) {
  const issues = getWorkOrderMaterialIssues(order.id);
  if (!issues.length) return '<div class="empty-state compact-empty">暂无领料记录</div>';
  return `
    <div class="list" aria-label="${escapeHtml(order.id)} 领料批次">
      ${issues
        .map((issue) => {
          const material = getMaterialItems().find((item) => item.code === issue.materialCode) || issue;
          const unit = materialUnitLabel(material);
          const statusClass = issue.isCorrected ? "warn" : issue.isFefoRecommended ? "running" : "pending";
          const statusText = issue.isCorrected ? "已冲正" : issue.isFefoRecommended ? "按 FEFO 领料" : "非 FEFO / 强制领料";
          const details = [
            issue.overrideReason ? `原因：${issue.overrideReason}` : "",
            issue.note ? `备注：${issue.note}` : "",
            issue.isCorrected && issue.correctionReason ? `冲正原因：${issue.correctionReason}` : "",
          ].filter(Boolean).join("；");
          return `
            <div class="list-item">
              <div class="item-top">
                <div class="item-title">${escapeHtml(issue.materialName || issue.materialCode)} / ${escapeHtml(issue.batchNo)}</div>
                <span class="status ${statusClass}">${escapeHtml(statusText)}</span>
              </div>
              <div class="item-meta">料号：${escapeHtml(issue.materialCode)} / 领料：${escapeHtml(issue.qty)}${escapeHtml(unit)} / 净领料：${escapeHtml(issue.netQty)}${escapeHtml(unit)}</div>
              <div class="item-meta">操作人：${escapeHtml(issue.operator || "-")} / 时间：${escapeHtml(formatDateTime(issue.createdAt))}</div>
              <div class="item-note">${escapeHtml(details || "无备注")}</div>
              ${issue.isCorrected ? `<div class="item-note">冲正时间：${escapeHtml(formatDateTime(issue.correctedAt))} / 冲正流水：${escapeHtml(issue.correctionMovementId || "-")}</div>` : ""}
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderWorkOrderIssueForm(order) {
  if (!state.workOrderIssueFormOpen) {
    return "";
  }

  const context = getWorkOrderIssueFormContext();
  if (!context.material || !context.batches.length || !context.batch) {
    return '<div class="empty-state compact-empty">当前没有可领用批次。请先到物料库存建立并入库批次。</div>';
  }
  const unit = materialUnitLabel(context.material);
  const advice = buildFefoAdvice(context.batch, context.qty);
  return `
    <form class="editor-form" id="work-order-issue-form">
      <div class="editor-grid two">
        <label>
          物料
          <select name="materialCode" id="work-order-issue-material">
            ${context.materialItems.map((item) => `<option value="${escapeHtml(item.code)}" ${item.code === context.materialCode ? "selected" : ""}>${escapeHtml(item.code)} / ${escapeHtml(item.name)}</option>`).join("")}
          </select>
        </label>
        <label>
          批次
          <select name="batchNo" id="work-order-issue-batch">
            ${context.batches.map((batch) => `<option value="${escapeHtml(batch.batchNo)}" ${batch.batchNo === context.batchNo ? "selected" : ""}>${escapeHtml(batch.batchNo)} / 库存 ${escapeHtml(batch.stockQty)}${escapeHtml(unit)} / ${escapeHtml(formatExpiryDistance(daysUntilExpiry(batch.expiryDate)))}</option>`).join("")}
          </select>
        </label>
        <label>领料数量（单位：${escapeHtml(unit)}）<input name="qty" id="work-order-issue-qty" type="number" min="0.001" step="0.001" value="${escapeHtml(context.qty)}" required /></label>
        <label>当前库位<input id="work-order-issue-location" value="${escapeHtml(context.batch.location || "-")}" readonly /></label>
        <label class="span-two">备注<input name="note" autocomplete="new-password" placeholder="可选，例如：WO 备料、试样领用" /></label>
      </div>
      <div id="work-order-issue-fefo-preview">${renderFefoAdviceHtml(context.batch, context.qty)}</div>
      <label class="override-reason-field ${advice.reasonRequired ? "" : "hidden"}" id="work-order-issue-reason-field">
        不按 FEFO / 过期强制领料原因
        <input name="overrideReason" autocomplete="new-password" placeholder="例如：研发试料、客户指定、异常处理" />
      </label>
      <div class="editor-actions">
        <button class="primary-btn" type="submit">确认领料</button>
        <button class="ghost-btn" type="button" id="cancel-work-order-issue-btn">取消</button>
      </div>
      <p class="helper-text">领料会扣减原材料批次库存；报工只记录工序进度，两者不会互相替代。</p>
    </form>
  `;
}

function refreshWorkOrderIssueFefoPreview() {
  const form = document.getElementById("work-order-issue-form");
  if (!form) return;
  const materialCode = String(form.elements.materialCode.value || "");
  const batchNo = String(form.elements.batchNo.value || "");
  const qty = Number(form.elements.qty.value || 0);
  const batch = getMaterialBatches().find((item) => item.materialCode === materialCode && item.batchNo === batchNo) || null;
  const preview = document.getElementById("work-order-issue-fefo-preview");
  const reasonField = document.getElementById("work-order-issue-reason-field");
  const locationField = document.getElementById("work-order-issue-location");
  if (!batch) {
    if (preview) preview.innerHTML = renderFefoAdviceHtml(null, qty);
    reasonField?.classList.add("hidden");
    if (locationField) locationField.value = "-";
    return;
  }
  const advice = buildFefoAdvice(batch, qty);
  if (preview) preview.innerHTML = renderFefoAdviceHtml(batch, qty);
  reasonField?.classList.toggle("hidden", !advice.reasonRequired);
  if (locationField) locationField.value = batch.location || "-";
}

function routeToText(route = defaultRoute) {
  return route.map((step) => `${step.name}|${step.status || "待开始"}`).join("\n");
}

function parseRouteText(text) {
  const rows = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [namePart, statusPart] = line.split("|");
      return {
        name: String(namePart || "").trim(),
        status: String(statusPart || "待开始").trim() || "待开始",
      };
    })
    .filter((step) => step.name);
  return rows.length ? rows : defaultRoute.map((step) => ({ ...step }));
}

function renderOptions(options, selectedValue, placeholder = "") {
  const buffer = [];
  if (placeholder) {
    buffer.push(`<option value="">${escapeHtml(placeholder)}</option>`);
  }
  options.forEach((value) => {
    buffer.push(`<option value="${escapeHtml(value)}" ${value === selectedValue ? "selected" : ""}>${escapeHtml(value)}</option>`);
  });
  return buffer.join("");
}

function getSelectedSample() {
  return state.data?.samples.find((item) => item.id === state.selectedSampleId) || null;
}

function getSelectedOrder() {
  return state.data?.workOrders.find((item) => item.id === state.selectedOrderId) || null;
}

function materialKey(material) {
  return material ? `${material.materialCode || material.code}|${material.batchNo}` : "";
}

function getMaterialItems() {
  if (state.data?.materialItems?.length) return state.data.materialItems;
  const seen = new Map();
  (state.data?.materials || []).forEach((item) => {
    if (!seen.has(item.code)) {
      seen.set(item.code, {
        code: item.code,
        name: item.name,
        spec: item.spec,
        unit: item.unit,
        safetyQty: item.safetyQty,
        defaultLocation: item.location,
        supplier: item.supplier || "",
        status: "启用",
      });
    }
  });
  return Array.from(seen.values());
}

function getMaterialBatches() {
  if (state.data?.materialBatches?.length) return state.data.materialBatches;
  return (state.data?.materials || []).map((item) => ({
    id: item.materialBatchId || materialKey(item),
    materialCode: item.code,
    batchNo: item.batchNo,
    initialQty: item.initialQty ?? item.stockQty,
    stockQty: item.stockQty,
    location: item.location,
    receivedDate: item.receivedDate || "",
    expiryDate: item.expiryDate || "",
    supplier: item.supplier || "",
    note: item.note || "",
    batchStatus: item.batchStatus || getBatchStatus(item),
  }));
}

function getBatchStatus(batch) {
  if (Number(batch?.stockQty || 0) <= 0) return "已用完";
  const expiryDate = String(batch?.expiryDate || "").slice(0, 10);
  if (!expiryDate) return "正常";
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const soon = new Date(today);
  soon.setHours(0, 0, 0, 0);
  soon.setDate(soon.getDate() + 30);
  const soonKey = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  if (expiryDate < todayKey) return "已过期";
  if (expiryDate <= soonKey) return "即将过期";
  return "正常";
}

function daysUntilExpiry(value) {
  const expiryDate = String(value || "").slice(0, 10);
  if (!expiryDate) return null;
  const today = new Date();
  const todayDate = new Date(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`);
  const expiry = new Date(expiryDate);
  return Math.round((expiry.getTime() - todayDate.getTime()) / 86400000);
}

function batchStatusClass(status) {
  if (status === "正常") return "running";
  if (status === "即将过期") return "pending";
  if (status === "已用完") return "";
  return "warn";
}

function getMaterialSummary(materialCode) {
  const fromState = (state.data?.materialSummaries || []).find((item) => item.materialCode === materialCode);
  if (fromState) return fromState;
  const material = getMaterialItems().find((item) => item.code === materialCode) || {};
  const batches = getMaterialBatches().filter((item) => item.materialCode === materialCode);
  const totalStockQty = batches.reduce((sum, batch) => sum + Number(batch.stockQty || 0), 0);
  const nearestExpiryDate = batches
    .filter((batch) => Number(batch.stockQty || 0) > 0 && batch.expiryDate)
    .map((batch) => String(batch.expiryDate).slice(0, 10))
    .sort()[0] || "";
  return {
    materialCode,
    name: material.name || "",
    spec: material.spec || "",
    unit: material.unit || "",
    safetyQty: Number(material.safetyQty || 0),
    totalStockQty,
    batchCount: batches.length,
    nearestExpiryDate,
    lowStock: totalStockQty < Number(material.safetyQty || 0),
    expiringSoonBatchCount: batches.filter((batch) => getBatchStatus(batch) === "即将过期").length,
    expiredBatchCount: batches.filter((batch) => getBatchStatus(batch) === "已过期").length,
    usedUpBatchCount: batches.filter((batch) => getBatchStatus(batch) === "已用完").length,
    status: material.status || "启用",
  };
}

function matchesMaterialFilter(item, filterKey) {
  if (filterKey === "all") return true;
  const summary = getMaterialSummary(item.code);
  if (filterKey === "low") return Boolean(summary.lowStock);
  if (filterKey === "soon") return Number(summary.expiringSoonBatchCount || 0) > 0;
  if (filterKey === "expired") return Number(summary.expiredBatchCount || 0) > 0;
  if (filterKey === "used-up") return Number(summary.usedUpBatchCount || 0) > 0;
  return true;
}

function buildLocalFefoPlan(materialCode, qty, includeExpired = false) {
  const material = getMaterialItems().find((item) => item.code === materialCode) || {};
  const unit = materialUnitLabel(material);
  const candidates = getMaterialBatches()
    .filter((batch) => batch.materialCode === materialCode && Number(batch.stockQty || 0) > 0)
    .map((batch) => ({ ...batch, status: getBatchStatus(batch), daysUntilExpiry: daysUntilExpiry(batch.expiryDate) }))
    .filter((batch) => includeExpired || batch.status !== "已过期")
    .sort((left, right) => {
      const leftExpiry = String(left.expiryDate || "9999-12-31").slice(0, 10);
      const rightExpiry = String(right.expiryDate || "9999-12-31").slice(0, 10);
      if (leftExpiry !== rightExpiry) return leftExpiry.localeCompare(rightExpiry);
      const leftReceived = String(left.receivedDate || "9999-12-31").slice(0, 10);
      const rightReceived = String(right.receivedDate || "9999-12-31").slice(0, 10);
      if (leftReceived !== rightReceived) return leftReceived.localeCompare(rightReceived);
      return String(left.batchNo || "").localeCompare(String(right.batchNo || ""));
    });
  let remainingQty = Math.max(0, Number(qty || 0));
  const plan = [];
  for (const batch of candidates) {
    if (remainingQty <= 0) break;
    const issueQty = Math.min(Number(batch.stockQty || 0), remainingQty);
    plan.push({
      ...batch,
      qty: issueQty,
      unit,
    });
    remainingQty -= issueQty;
  }
  return { plan, recommendedBatch: plan[0] || null, remainingQty, unit };
}

function formatExpiryDistance(days) {
  if (days === null || days === undefined || Number.isNaN(days)) return "未设置";
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  return `${days} 天后到期`;
}

function buildFefoAdvice(selectedBatch, qty) {
  if (!selectedBatch) {
    return { tone: "", title: "未选择批次", text: "先选择一个批次，再查看 FEFO 推荐。", reasonRequired: false };
  }
  const selectedStatus = selectedBatch.batchStatus || getBatchStatus(selectedBatch);
  const plan = buildLocalFefoPlan(selectedBatch.materialCode, qty);
  const recommended = plan.recommendedBatch;
  const unit = plan.unit || "";
  const planText = plan.plan.length
    ? plan.plan.map((item) => `${item.batchNo} ${item.qty}${unit}`).join(" + ")
    : "暂无可用未过期批次";

  if (selectedStatus === "已过期") {
    return {
      tone: "warn",
      title: "当前批次已过期",
      text: `如必须出库，需要填写原因。系统仍会记录本次强制出库。推荐拆分：${planText}`,
      reasonRequired: true,
    };
  }

  if (!recommended) {
    return {
      tone: "warn",
      title: "没有可推荐批次",
      text: "当前物料没有可用的未过期库存，请检查库存或改为入库。",
      reasonRequired: false,
    };
  }

  if (recommended.batchNo !== selectedBatch.batchNo) {
    return {
      tone: "warn",
      title: `FEFO 建议先用 ${recommended.batchNo}`,
      text: `当前选中批次不是最早过期批次。如仍要使用当前批次，请填写原因。推荐拆分：${planText}`,
      reasonRequired: true,
    };
  }

  return {
    tone: "running",
    title: "当前批次符合 FEFO",
    text: `建议按最早过期优先出库。推荐拆分：${planText}${plan.remainingQty > 0 ? `，仍缺 ${plan.remainingQty}${unit}` : ""}`,
    reasonRequired: false,
  };
}

function renderFefoAdviceHtml(selectedBatch, qty) {
  const advice = buildFefoAdvice(selectedBatch, qty);
  return `
    <div class="fefo-advice ${escapeHtml(advice.tone)}" data-reason-required="${advice.reasonRequired ? "1" : "0"}">
      <div class="item-title">${escapeHtml(advice.title)}</div>
      <div class="item-note">${escapeHtml(advice.text)}</div>
    </div>
  `;
}

function getFilteredMaterialItems() {
  return getMaterialItems().filter((item) => matchesMaterialFilter(item, state.materialFilter));
}

function matchesBatchFilter(batch, filterKey = state.batchFilter) {
  if (filterKey === "all") return true;
  const status = batch.batchStatus || getBatchStatus(batch);
  const material = getMaterialItems().find((item) => item.code === batch.materialCode);
  if (filterKey === "low") return status === "低库存" || (Number(batch.stockQty || 0) > 0 && Number(batch.stockQty || 0) <= Number(material?.safetyQty || 0));
  if (filterKey === "soon") return status === "即将过期";
  if (filterKey === "expired") return status === "已过期";
  if (filterKey === "used-up") return status === "已用完" || Number(batch.stockQty || 0) <= 0;
  return true;
}

function getSelectedBatchMovements(data = state.data, selectedKey = state.selectedMaterialKey) {
  const batch = (data?.materialBatches || []).find((item) => materialKey(item) === selectedKey);
  if (!batch) return [];
  return (data?.stockMovements || [])
    .filter((item) => item.materialCode === batch.materialCode && item.batchNo === batch.batchNo)
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function movementSignature(data = state.data) {
  const first = getSelectedBatchMovements(data)[0];
  return first ? `${first.id || ""}|${first.createdAt || ""}` : "";
}

function exportMaterialItemsCsv() {
  const rows = getFilteredMaterialItems().map((item) => {
    const summary = getMaterialSummary(item.code);
    return [
      item.code,
      item.name,
      item.spec || "",
      materialUnitLabel(item),
      summary.totalStockQty,
      summary.safetyQty,
      item.defaultLocation || "",
      item.status || "启用",
      formatDateTime(item.createdAt),
    ];
  });
  downloadCsv(`material-items-${fileDateStamp()}.csv`, ["物料编号", "名称", "规格", "单位", "总库存", "安全库存", "默认库位", "状态", "创建时间"], rows);
}

function exportMaterialBatchesCsv() {
  const selectedMaterial = getSelectedMaterialItem();
  const rows = getMaterialBatches()
    .filter((batch) => selectedMaterial && batch.materialCode === selectedMaterial.code && matchesBatchFilter(batch))
    .map((batch) => {
      const material = getMaterialItems().find((item) => item.code === batch.materialCode) || {};
      return [
        batch.materialCode,
        material.name || "",
        batch.batchNo,
        Number(batch.stockQty || 0),
        Number(batch.initialQty || 0),
        batch.location || "",
        String(batch.receivedDate || "").slice(0, 10),
        String(batch.expiryDate || "").slice(0, 10),
        batch.batchStatus || getBatchStatus(batch),
        batch.supplier || "",
        batch.note || "",
      ];
    });
  downloadCsv(
    `material-batches-${fileDateStamp()}.csv`,
    ["物料编号", "物料名称", "批次号", "当前库存", "初始数量", "库位", "来料日期", "保质期截止日期", "状态", "供应商", "备注"],
    rows
  );
}

function exportStockMovementsCsv() {
  const rows = getSelectedBatchMovements()
    .map((item) => {
      const material = getMaterialItems().find((entry) => entry.code === item.materialCode) || {};
      return [
        formatDateTime(item.createdAt),
        movementTypeLabel(item.type),
        item.materialCode,
        material.name || "",
        item.batchNo,
        Number(item.qty || 0),
        item.location || "",
        item.operator || "",
        item.note || "",
        movementReason(item),
        item.correctionOfMovementId ? `冲正 ${item.correctionOfMovementId}` : item.correctedByMovementId ? `已被 ${item.correctedByMovementId} 冲正` : "",
      ];
    });
  downloadCsv(
    `stock-movements-${fileDateStamp()}.csv`,
    ["时间", "类型", "物料编号", "物料名称", "批次号", "数量", "库位", "操作人", "备注", "FEFO 原因 / 强制原因", "关联纠错记录"],
    rows
  );
}

function exportMaterialBatchTraceCsv() {
  const trace = state.materialTraceData;
  if (!trace) {
    showToast("追溯数据尚未加载");
    return;
  }
  const groupByOrderId = new Map((trace.workOrders || []).map((group) => [group.workOrderId, group]));
  const rows = traceIssueRows(trace).map((issue) => {
    const group = groupByOrderId.get(issue.workOrderId) || {};
    const order = group.workOrder || issue.workOrder || {};
    const original = issue.originalMovement || issue.stockMovement || {};
    const correction = issue.correctionMovement || {};
    return [
      issue.createdAt ? formatDateTime(issue.createdAt) : "",
      issue.statusLabel || traceStatusLabel(issue.status),
      issue.workOrderId || "",
      order.product || "",
      order.status || "",
      group.issueCount ?? "",
      group.statusLabel || traceStatusLabel(group.status),
      group.latestIssueAt ? formatDateTime(group.latestIssueAt) : "",
      group.historicalQty ?? "",
      group.effectiveNetQty ?? "",
      group.correctedQty ?? "",
      group.unknownQty ?? "",
      group.activeIssueCount ?? "",
      group.correctedIssueCount ?? "",
      group.unknownIssueCount ?? "",
      issue.materialCode || trace.batch?.materialCode || "",
      issue.materialName || trace.material?.name || "",
      issue.batchNo || trace.batch?.batchNo || "",
      issue.qty ?? "",
      issue.effectiveQty ?? "",
      issue.unit || trace.batch?.unit || "",
      issue.location || "",
      issue.operator || "",
      issue.recommendedBatchNo || "",
      issue.isFefoRecommended ? "是" : "否",
      issue.overrideReason || "",
      issue.note || "",
      original.id || "",
      original.id ? movementTypeLabel(original.type) : "",
      original.qty ?? "",
      original.beforeQty ?? "",
      original.afterQty ?? "",
      original.location || "",
      original.operator || "",
      original.source || "",
      original.createdAt ? formatDateTime(original.createdAt) : "",
      original.correctedByMovementId || "",
      original.correctionReason || issue.correctionReason || "",
      original.correctedAt ? formatDateTime(original.correctedAt) : "",
      correction.id || "",
      correction.id ? movementTypeLabel(correction.type) : "",
      correction.qty ?? "",
      correction.beforeQty ?? "",
      correction.afterQty ?? "",
      correction.location || "",
      correction.operator || "",
      correction.source || "",
      correction.createdAt ? formatDateTime(correction.createdAt) : "",
      correction.note || "",
    ];
  });
  downloadCsv(
    `material-batch-trace-${trace.batch?.materialCode || "batch"}-${trace.batch?.batchNo || "history"}-${fileDateStamp()}.csv`,
    [
      "领料时间", "追溯状态", "工单号", "产品", "工单状态", "工单领料笔数", "工单汇总状态", "工单最近领料时间", "工单历史总量", "工单有效净领料", "工单已冲正数量", "工单待核验数量", "工单当前有效笔数", "工单已冲正笔数", "工单待核验笔数",
      "物料编号", "物料名称", "批次号", "领料数量", "有效数量", "单位", "库位", "领料操作人", "FEFO推荐批次", "符合FEFO", "强制原因", "领料备注",
      "原始流水ID", "原始流水类型", "原始流水数量", "原始流水前库存", "原始流水后库存", "原始流水库位", "原始流水操作人", "原始流水来源", "原始流水时间", "关联冲正流水ID", "冲正原因", "冲正时间",
      "冲正流水ID", "冲正流水类型", "冲正流水数量", "冲正流水前库存", "冲正流水后库存", "冲正流水库位", "冲正流水操作人", "冲正流水来源", "冲正流水时间", "冲正流水备注",
    ],
    rows
  );
}

function getSelectedMaterialItem() {
  if (state.materialEditorMode === "create") return null;
  return getMaterialItems().find((item) => item.code === state.selectedMaterialCode) || getMaterialItems()[0] || null;
}

function getSelectedMaterial() {
  return getMaterialBatches().find((item) => materialKey(item) === state.selectedMaterialKey) || null;
}

function buildMaterialBatchCode(batch) {
  if (!batch) return "";
  return ["MAT", batch.materialCode || batch.code, batch.batchNo, batch.location || ""].join("|");
}

function buildMobileBatchLink(material) {
  if (!material) return "";
  return `${window.location.origin}/mobile.html?batch=${encodeURIComponent(buildMaterialBatchCode(material))}`;
}

function buildBatchLabelLink(material) {
  if (!material) return "";
  const materialItem = getMaterialItems().find((item) => item.code === (material.materialCode || material.code)) || {};
  const params = new URLSearchParams({
    batch: buildMaterialBatchCode(material),
    materialName: materialItem.name || material.name || "",
    stockQty: String(material.stockQty ?? ""),
    unit: materialItem.unit || material.unit || "",
    expiryDate: String(material.expiryDate || "").slice(0, 10),
  });
  return `./batch-label.html?${params.toString()}`;
}

function buildWorkOrderCode(order) {
  if (!order) return "";
  return ["WO", order.id, order.currentProcess || ""].join("|");
}

function buildMobileWorkOrderLink(order) {
  if (!order) return "";
  return `${window.location.origin}/mobile.html?workOrder=${encodeURIComponent(order.id)}`;
}

function buildWorkOrderLabelLink(order) {
  if (!order) return "";
  const params = new URLSearchParams({
    workOrder: order.id || "",
    sampleId: order.sampleId || "",
    product: order.product || "",
    currentProcess: order.currentProcess || "",
    plannedQty: String(order.plannedQty ?? ""),
    doneQty: String(order.doneQty ?? ""),
    dueAt: order.dueAt || "",
    status: order.status || "",
    code: buildWorkOrderCode(order),
  });
  return `./work-order-label.html?${params.toString()}`;
}

function buildSampleCode(sample) {
  if (!sample) return "";
  return ["SP", sample.id, sample.version || ""].join("|");
}

function buildAdminSampleLink(sample) {
  if (!sample) return "";
  return `${window.location.origin}/admin.html?sample=${encodeURIComponent(sample.id)}`;
}

function buildSampleLabelLink(sample) {
  if (!sample) return "";
  const params = new URLSearchParams({
    sample: sample.id || "",
    name: sample.name || "",
    customer: sample.customer || "",
    version: sample.version || "",
    owner: sample.owner || "",
    dueDate: sample.dueDate || "",
    status: sample.status || "",
    code: buildSampleCode(sample),
  });
  return `./sample-label.html?${params.toString()}`;
}

function makeSampleDraft(sample = {}) {
  return {
    name: sample.name || "",
    customer: sample.customer || "",
    version: sample.version || "",
    owner: sample.owner || "",
    dueDate: sample.dueDate || "",
    status: sample.status || "待打样",
  };
}

function makeOrderDraft(order = {}) {
  const route = Array.isArray(order.route) && order.route.length ? order.route : defaultRoute;
  return {
    sampleId: order.sampleId || state.selectedSampleId || "",
    product: order.product || "",
    plannedQty: Number(order.plannedQty ?? 10),
    doneQty: Number(order.doneQty ?? 0),
    currentProcess: order.currentProcess || route[0]?.name || "备料",
    priority: order.priority || "中",
    status: order.status || "待领料",
    dueAt: order.dueAt ? String(order.dueAt).slice(0, 10) : "",
    routeText: routeToText(route),
  };
}

function syncSelections() {
  if (!state.data) return;

  const sampleExists = state.data.samples.some((item) => item.id === state.selectedSampleId);
  if (!sampleExists) {
    state.selectedSampleId = state.data.samples[0]?.id || "";
    if (!state.selectedSampleId) state.sampleEditorMode = "create";
  }

  const orderExists = state.data.workOrders.some((item) => item.id === state.selectedOrderId);
  if (!orderExists) {
    state.selectedOrderId = state.orderEditorMode === "create" ? "" : state.data.workOrders[0]?.id || "";
    if (!state.selectedOrderId && !state.data.workOrders.length) state.orderEditorMode = "create";
  }

  const materialItems = getMaterialItems();
  const traceBatch = state.materialTraceOpen
    ? getMaterialBatches().find((item) => item.id === state.materialTraceBatchId)
    : null;
  if (traceBatch) {
    state.selectedMaterialCode = traceBatch.materialCode;
    state.selectedMaterialKey = materialKey(traceBatch);
  }
  const materialCodeExists = materialItems.some((item) => item.code === state.selectedMaterialCode);
  if (state.materialEditorMode === "create") {
    state.selectedMaterialCode = "";
    state.selectedMaterialKey = "";
  } else if (!materialCodeExists && !state.materialTraceOpen) {
    state.selectedMaterialCode = materialItems[0]?.code || "";
  }

  const selectedBatches = getMaterialBatches().filter((item) => item.materialCode === state.selectedMaterialCode);
  const materialExists = selectedBatches.some((item) => materialKey(item) === state.selectedMaterialKey);
  if (state.materialEditorMode !== "create" && !materialExists && !state.materialTraceOpen) {
    state.selectedMaterialKey = materialKey(selectedBatches[0]);
  }
}

function renderStats() {
  const root = document.getElementById("stats-grid");
  const stats = [
    { label: "进行中生产单", value: state.data.workOrders.filter((item) => item.status === "生产中").length, meta: "现场工序报工后会刷新进度" },
    { label: "待处理预警", value: state.data.alerts.filter((item) => item.status === "open").length, meta: "缺料、临期、异常优先处理" },
    { label: "打样项目", value: state.data.samples.length, meta: "样品单和生产单分开管理" },
    { label: "累计报工次数", value: state.data.reports.length, meta: "手机端提交后回流管理端" },
  ];
  root.innerHTML = stats
    .map(
      (item) => `
        <article class="stat-card">
          <div class="stat-label">${item.label}</div>
          <div class="stat-value">${item.value}</div>
          <div class="stat-meta">${item.meta}</div>
        </article>
      `
    )
    .join("");
}

function renderList(rootId, items, mapFn) {
  const root = document.getElementById(rootId);
  root.innerHTML = `<div class="list">${items.map(mapFn).join("") || `<div class="list-item">暂无数据</div>`}</div>`;
}

function getDashboardRiskItems() {
  const materialRisks = getMaterialItems()
    .map((material) => ({ material, summary: getMaterialSummary(material.code) }))
    .filter(({ summary }) => summary.lowStock)
    .map(({ material, summary }) => ({
      title: material.name,
      meta: `${material.code} · 批次 ${summary.batchCount} 个 · 最近到期 ${summary.nearestExpiryDate || "-"}`,
      note: `当前 ${summary.totalStockQty} ${material.unit} / 安全库存 ${summary.safetyQty} ${material.unit}`,
      label: "低库存",
      type: "低库存",
      materialCode: material.code,
      materialName: material.name,
      batchNo: "",
      currentStock: summary.totalStockQty,
      safetyStock: summary.safetyQty,
      expiryDate: summary.nearestExpiryDate || "",
      riskStatus: "低库存",
      riskDescription: `当前库存低于安全库存，涉及 ${summary.batchCount} 个批次`,
    }));
  const alertRisks = state.data.alerts
    .filter((item) => item.status === "open")
    .map((item) => ({
      title: item.title,
      meta: "系统预警",
      note: item.text,
      label: "预警",
      type: "系统预警",
      materialCode: item.materialCode || "",
      materialName: item.materialName || "",
      batchNo: item.batchNo || "",
      currentStock: item.currentStock ?? "",
      safetyStock: item.safetyStock ?? "",
      expiryDate: item.expiryDate || "",
      riskStatus: item.title || "预警",
      riskDescription: item.text || "",
    }));
  return [...materialRisks, ...alertRisks];
}

function getDashboardActivities() {
  return [...(state.data.activities || [])]
    .map((item, index) => ({ item, index, time: new Date(item.createdAt || 0).getTime() || 0 }))
    .sort((left, right) => right.time - left.time || left.index - right.index)
    .map(({ item }) => item);
}

function activityExportFields(item) {
  const title = String(item.title || "");
  const note = String(item.note || "");
  const meta = String(item.meta || "");
  const workOrderId = title.match(/WO-[A-Za-z0-9-]+/i)?.[0] || note.match(/WO-[A-Za-z0-9-]+/i)?.[0] || "";
  const materialCode = title.match(/RM-[A-Za-z0-9-]+/i)?.[0] || note.match(/RM-[A-Za-z0-9-]+/i)?.[0] || "";
  const operationType = ["工单领料", "报工", "冲正", "入库", "出库", "建档"].find((type) => title.includes(type)) || title;
  const operator = meta.split("·")[0]?.trim() || "";
  return { operationType, workOrderId, materialCode, operator };
}

function bindDashboardExports(risks, activities) {
  document.getElementById("export-dashboard-priority-orders-btn").onclick = () => {
    const rows = state.data.workOrders.map((order) => {
      const quality = getWorkOrderQualitySummary(order);
      const dueRisk = getDueDateRisk(order);
      return [
        order.id,
        order.product,
        order.currentProcess,
        order.status,
        Number(order.plannedQty || 0),
        quality.finishedGoodQty,
        quality.currentTransferableGoodQty,
        quality.badQty,
        order.dueAt || "",
        dueRisk.key === "overdue" ? "是" : "否",
        ["高", "加急"].includes(order.priority) ? "是" : "否",
      ];
    });
    downloadCsv(
      `dashboard-priority-orders-${fileDateStamp()}.csv`,
      ["工单号", "产品", "当前工序", "工单状态", "计划数量", "成品良品", "当前可流转", "累计不良", "交期", "是否逾期", "是否加急"],
      rows
    );
  };

  document.getElementById("export-dashboard-risks-btn").onclick = () => {
    downloadCsv(
      `dashboard-risks-${fileDateStamp()}.csv`,
      ["类型", "物料编号", "物料名称", "批次号", "当前库存", "安全库存", "到期日期", "风险状态", "风险说明"],
      risks.map((item) => [item.type, item.materialCode, item.materialName, item.batchNo, item.currentStock, item.safetyStock, item.expiryDate, item.riskStatus, item.riskDescription])
    );
  };

  document.getElementById("export-dashboard-process-progress-btn").onclick = () => {
    const rows = state.data.workOrders.map((order) => {
      const quality = getWorkOrderQualitySummary(order);
      const progress = getProcessProgressSummary(order);
      const nextStage = (order.route || []).find((step) => step.status === "待开始")?.name || "待完工";
      return [
        order.id,
        order.product,
        order.currentProcess,
        nextStage,
        order.status,
        `${progress.completed}/${progress.total || 0}`,
        quality.currentTransferableGoodQty,
        quality.finishedGoodQty,
      ];
    });
    downloadCsv(
      `dashboard-process-progress-${fileDateStamp()}.csv`,
      ["工单号", "产品", "当前工序", "下一工序", "工单状态", "工序完成进度", "当前可流转", "成品良品"],
      rows
    );
  };

  document.getElementById("export-dashboard-activities-btn").onclick = () => {
    const rows = activities.map((item) => {
      const fields = activityExportFields(item);
      return [formatDateTime(item.createdAt), fields.operationType, item.title || "", fields.workOrderId, fields.materialCode, item.batchNo || "", fields.operator, item.qty ?? "", item.note || ""];
    });
    downloadCsv(
      `dashboard-activities-${fileDateStamp()}.csv`,
      ["操作时间", "操作类型", "操作对象", "工单号", "物料编号", "批次号", "操作人", "数量", "备注 / 原因"],
      rows
    );
  };
}

function renderDashboard() {
  renderStats();

  renderList("focus-orders", state.data.workOrders, (order) => {
    const quality = getWorkOrderQualitySummary(order);
    const statusText = getOrderDisplayStatus(order, quality);
    return `
      <div class="list-item">
        <div class="item-top">
          <div class="item-title">${escapeHtml(order.id)} · ${escapeHtml(order.product)}</div>
          <span class="status ${normalizeStatus(quality.hasFinalShortage ? "延期" : order.status)}">${escapeHtml(statusText)}</span>
        </div>
        <div class="item-meta">当前工序：${escapeHtml(order.currentProcess)} · 交期：${escapeHtml(order.dueAt)}</div>
        <div class="progress-row">
          <div class="progress-label"><span>成品良品</span><span>${quality.finishedGoodQty}/${order.plannedQty}</span></div>
          <div class="progress-bar"><div class="progress-fill" style="width:${percent(quality.finishedGoodQty, order.plannedQty)}%"></div></div>
        </div>
        <div class="item-meta">当前可流转 ${quality.currentTransferableGoodQty} · 累计报工 ${quality.completedQty}</div>
      </div>
    `;
  });

  const risks = getDashboardRiskItems();
  renderList(
    "risk-list",
    risks.slice(0, 6),
    (item) => `
      <div class="list-item">
        <div class="item-top">
          <div class="item-title">${escapeHtml(item.title)}</div>
          <span class="status warn">${escapeHtml(item.label)}</span>
        </div>
        <div class="item-meta">${escapeHtml(item.meta)}</div>
        <div class="item-note">${escapeHtml(item.note)}</div>
      </div>
    `
  );

  renderList("stage-board", state.data.workOrders, (order) => {
    const nextStage = (order.route || []).find((step) => step.status === "待开始")?.name || "待完工";
    return `
      <div class="list-item">
        <div class="item-top">
          <div class="item-title">${escapeHtml(order.product)}</div>
          <span class="status ${normalizeStatus(order.status)}">${escapeHtml(order.currentProcess)}</span>
        </div>
        <div class="item-meta">${escapeHtml(order.id)} · 下一步：${escapeHtml(nextStage)}</div>
      </div>
    `;
  });

  const activities = getDashboardActivities();
  const pageCount = Math.max(1, Math.ceil(activities.length / activityPageSize));
  state.activityPage = Math.min(Math.max(1, state.activityPage), pageCount);
  const pageStart = (state.activityPage - 1) * activityPageSize;
  renderList(
    "activity-list",
    activities.slice(pageStart, pageStart + activityPageSize),
    (item) => `
      <div class="list-item">
        <div class="item-top"><div class="item-title">${escapeHtml(item.title)}</div></div>
        <div class="item-meta">${escapeHtml(item.meta || "")}</div>
        <div class="item-note">${escapeHtml(item.note || "")}</div>
      </div>
    `
  );

  const pagination = document.getElementById("activity-pagination");
  pagination.classList.toggle("hidden", activities.length <= activityPageSize);
  document.getElementById("activity-page-label").textContent = `${state.activityPage} / ${pageCount}`;
  const previousButton = document.getElementById("activity-prev-btn");
  const nextButton = document.getElementById("activity-next-btn");
  previousButton.disabled = state.activityPage <= 1;
  nextButton.disabled = state.activityPage >= pageCount;
  previousButton.onclick = () => {
    if (state.activityPage <= 1) return;
    state.activityPage -= 1;
    renderDashboard();
  };
  nextButton.onclick = () => {
    if (state.activityPage >= pageCount) return;
    state.activityPage += 1;
    renderDashboard();
  };
  bindDashboardExports(risks, activities);
}

function renderSamples() {
  document.getElementById("sample-editor-title").textContent = state.sampleEditorMode === "create" ? "新建样品单" : "样品单编辑";
  document.getElementById("sample-table").innerHTML = `
    <div class="table">
      <div class="table-head sample-grid">
        <div>样品单号</div><div>项目</div><div>版本</div><div>负责人</div><div>截止</div><div>状态</div>
      </div>
      ${state.data.samples
        .map(
          (item) => `
            <div class="table-row sample-grid clickable ${item.id === state.selectedSampleId && state.sampleEditorMode === "edit" ? "active" : ""}" data-sample-id="${escapeHtml(item.id)}">
              <div>${escapeHtml(item.id)}</div>
              <div>${escapeHtml(item.name)} / ${escapeHtml(item.customer || "-")}</div>
              <div>${escapeHtml(item.version || "-")}</div>
              <div>${escapeHtml(item.owner || "-")}</div>
              <div>${escapeHtml(formatShortDate(item.dueDate))}</div>
              <div><span class="status ${normalizeStatus(item.status)}">${escapeHtml(item.status)}</span></div>
            </div>
          `
        )
        .join("")}
    </div>
  `;

  const sample = state.sampleEditorMode === "edit" ? getSelectedSample() : null;
  const draft = makeSampleDraft(sample || {});
  const sampleCode = buildSampleCode(sample);
  const sampleLabelLink = buildSampleLabelLink(sample);
  const adminSampleLink = buildAdminSampleLink(sample);
  const sampleLocalOnlyNote = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(window.location.origin)
    ? '<div class="item-note">当前是 localhost，本机打开标签页没问题；真机扫码要换成局域网地址或线上域名。</div>'
    : "";
  document.getElementById("sample-editor").innerHTML = `
    <form class="editor-form" id="sample-form">
      <div class="detail-block">
        <div class="detail-title">${sample ? `当前样品单：${escapeHtml(sample.id)}` : "编号保存后自动生成"}</div>
        <div class="item-note">建单时间：${escapeHtml(formatDateTime(sample?.createdAt))}</div>
        <div class="editor-grid two">
          <label>
            样品名称
            <input name="name" value="${escapeHtml(draft.name)}" placeholder="例如：减震鞋垫 2.0" required />
          </label>
          <label>
            客户 / 项目
            <input name="customer" value="${escapeHtml(draft.customer)}" placeholder="客户简称或项目名" />
          </label>
          <label>
            版本
            <input name="version" value="${escapeHtml(draft.version)}" placeholder="V1 / V2 / 样品A" />
          </label>
          <label>
            负责人
            <input name="owner" value="${escapeHtml(draft.owner)}" placeholder="打样负责人" required />
          </label>
          <label>
            截止日期
            <input name="dueDate" type="date" value="${escapeHtml(draft.dueDate)}" required />
          </label>
          <label>
            状态
            <select name="status">${renderOptions(sampleStatuses, draft.status)}</select>
          </label>
        </div>
      </div>
      ${
        sample
          ? `
            <div class="detail-block">
              <div class="panel-head">
                <h2>样品单二维码</h2>
                <div class="panel-actions">
                  <button class="ghost-btn slim-btn" id="copy-sample-code-btn" type="button">复制样品码</button>
                  <button class="ghost-btn slim-btn" id="copy-sample-link-btn" type="button">复制定位链接</button>
                  <a class="ghost-btn slim-btn" href="${escapeHtml(sampleLabelLink)}" target="_blank" rel="noreferrer">查看标签页</a>
                </div>
              </div>
              <div class="detail-title">样品码</div>
              <div class="code-block">${escapeHtml(sampleCode)}</div>
              <div class="detail-title">管理端定位链接</div>
              <div class="code-block">${escapeHtml(adminSampleLink)}</div>
              <div class="item-note">这张码偏向打样流转、版本留样和样品追溯。Alpha 版先让它定位到样品详情，后面再接客户确认、寄样记录都很顺。</div>
              ${sampleLocalOnlyNote}
            </div>
          `
          : ""
      }
      <div class="editor-actions">
        <button class="primary-btn" type="submit">${state.sampleEditorMode === "create" ? "保存样品单" : "更新样品单"}</button>
        ${state.sampleEditorMode === "create" ? `<button class="ghost-btn" type="button" id="cancel-sample-create-btn">取消</button>` : ""}
      </div>
    </form>
  `;

  document.querySelectorAll("[data-sample-id]").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedSampleId = row.getAttribute("data-sample-id");
      state.sampleEditorMode = "edit";
      renderSamples();
    });
  });

  const newSampleButton = document.getElementById("new-sample-btn");
  if (newSampleButton) {
    newSampleButton.onclick = () => {
      state.sampleEditorMode = "create";
      renderSamples();
    };
  }

  const cancelSampleButton = document.getElementById("cancel-sample-create-btn");
  if (cancelSampleButton) {
    cancelSampleButton.addEventListener("click", () => {
      state.sampleEditorMode = "edit";
      if (!state.selectedSampleId) state.selectedSampleId = state.data.samples[0]?.id || "";
      renderSamples();
    });
  }

  const sampleForm = document.getElementById("sample-form");
  if (sampleForm) {
    sampleForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(sampleForm);
      const payload = {
        name: formData.get("name"),
        customer: formData.get("customer"),
        version: formData.get("version"),
        owner: formData.get("owner"),
        dueDate: formData.get("dueDate"),
        status: formData.get("status"),
      };
      try {
        const mode = state.sampleEditorMode;
        const result =
          mode === "create"
            ? await api("/api/samples", { method: "POST", body: JSON.stringify(payload) })
            : await api(`/api/samples/${encodeURIComponent(state.selectedSampleId)}`, { method: "PUT", body: JSON.stringify(payload) });
        state.data = result.state;
        state.selectedSampleId = result.sample.id;
        state.sampleEditorMode = "edit";
        syncSelections();
        renderAll();
        showToast(mode === "create" ? "样品单已新建" : "样品单已更新");
      } catch (error) {
        showToast(error.message);
      }
    });
  }

  const copySampleCodeButton = document.getElementById("copy-sample-code-btn");
  if (copySampleCodeButton && sample) {
    copySampleCodeButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(sampleCode);
        showToast("样品码已复制");
      } catch {
        showToast("复制失败，请手动复制样品码");
      }
    });
  }

  const copySampleLinkButton = document.getElementById("copy-sample-link-btn");
  if (copySampleLinkButton && sample) {
    copySampleLinkButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(adminSampleLink);
        showToast("定位链接已复制");
      } catch {
        showToast("复制失败，请手动复制链接");
      }
    });
  }
}

function renderWorkOrderStatusFilters() {
  const root = document.getElementById("order-status-filters");
  root.innerHTML = orderFilterDefinitions
    .map((filter) => {
      const count = state.data.workOrders.filter((order) => matchesOrderFilter(order, filter.key)).length;
      return `
        <button class="order-filter ${state.orderFilter === filter.key ? "active" : ""}" type="button" data-order-filter="${filter.key}">
          <span>${filter.label}</span>
          <strong>${count}</strong>
        </button>
      `;
    })
    .join("");

  root.querySelectorAll("[data-order-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.orderFilter = button.getAttribute("data-order-filter") || "all";
      state.orderPage = 1;
      renderOrders();
    });
  });
}

function ensureMaterialTraceBackButton() {
  const existing = document.getElementById("back-material-trace-btn");
  if (existing) return existing;
  const button = document.createElement("button");
  button.className = "ghost-btn slim-btn hidden";
  button.id = "back-material-trace-btn";
  button.type = "button";
  button.textContent = "返回批次追溯";
  button.addEventListener("click", returnToMaterialTrace);
  const closeButton = document.getElementById("close-order-detail-btn");
  closeButton?.parentElement?.insertBefore(button, closeButton);
  return button;
}

function captureMaterialTraceScroll() {
  if (!state.materialTraceOpen) return;
  const drawerScroll = document.getElementById("order-drawer-scroll");
  if (drawerScroll) state.materialTraceScrollTop = drawerScroll.scrollTop;
}

function restoreMaterialTraceScroll() {
  if (!state.materialTraceOpen || state.materialTraceView !== "trace") return;
  window.requestAnimationFrame(() => {
    const drawerScroll = document.getElementById("order-drawer-scroll");
    if (drawerScroll) drawerScroll.scrollTop = state.materialTraceScrollTop;
  });
}

function bindMaterialTraceViewEvents() {
  document.querySelectorAll("[data-trace-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      captureMaterialTraceScroll();
      const workOrderId = button.getAttribute("data-trace-toggle") || "";
      state.materialTraceExpandedWorkOrders[workOrderId] = !state.materialTraceExpandedWorkOrders[workOrderId];
      renderOrderDetail();
    });
  });
  document.querySelectorAll("[data-trace-order-id]").forEach((button) => {
    button.addEventListener("click", () => openMaterialTraceWorkOrder(button.getAttribute("data-trace-order-id") || ""));
  });
  document.querySelector("[data-trace-export]")?.addEventListener("click", exportMaterialBatchTraceCsv);
}

function ensureOrderDrawerPlacement() {
  const main = document.querySelector(".main");
  const backdrop = document.getElementById("order-detail-backdrop");
  const panel = document.getElementById("order-detail-panel");
  if (!main || !backdrop || !panel) return;
  if (backdrop.parentElement !== main) main.appendChild(backdrop);
  if (panel.parentElement !== main) main.appendChild(panel);
}

function renderMaterialTraceDrawer() {
  captureMaterialTraceScroll();
  const root = document.getElementById("order-detail");
  root.innerHTML = renderMaterialTraceView();
  bindMaterialTraceViewEvents();
  restoreMaterialTraceScroll();
}

async function refreshMaterialBatchTrace({ silent = false } = {}) {
  if (!state.materialTraceOpen || !state.materialTraceBatchId) return false;
  const batchId = state.materialTraceBatchId;
  const requestVersion = state.materialTraceRequestVersion + 1;
  state.materialTraceRequestVersion = requestVersion;
  if (!silent || !state.materialTraceData) {
    state.materialTraceLoading = true;
    if (!state.materialTraceData) renderOrderDetail();
  }
  try {
    const result = await api(`/api/material-batches/${encodeURIComponent(batchId)}/work-order-issues`);
    if (!state.materialTraceOpen || state.materialTraceBatchId !== batchId || state.materialTraceRequestVersion !== requestVersion) return false;
    state.materialTraceData = result;
    state.materialTraceLoading = false;
    state.materialTraceError = "";
    renderOrderDetail();
    return true;
  } catch (error) {
    if (!state.materialTraceOpen || state.materialTraceBatchId !== batchId || state.materialTraceRequestVersion !== requestVersion) return false;
    state.materialTraceLoading = false;
    state.materialTraceError = error.message || "批次追溯查询失败";
    renderOrderDetail();
    return false;
  }
}

async function openMaterialBatchTrace(batch) {
  if (!batch?.id) {
    showToast("当前批次缺少有效编号");
    return;
  }
  if (state.orderFocusMode && !state.materialTraceOpen && !requestCloseOrderDrawer()) return;
  const sameBatch = state.materialTraceOpen && state.materialTraceBatchId === batch.id;
  state.selectedMaterialCode = batch.materialCode || state.selectedMaterialCode;
  state.selectedMaterialKey = materialKey(batch);
  state.materialTraceOpen = true;
  state.materialTraceBatchId = batch.id;
  state.materialTraceView = "trace";
  state.materialTraceReturnOrderId = state.selectedOrderId;
  state.materialTraceError = "";
  state.materialTraceLoading = true;
  state.orderEditorMode = "edit";
  state.orderDrawerMode = "trace";
  state.orderFocusMode = true;
  state.orderFormDirty = false;
  state.workOrderIssueFormOpen = false;
  state.workOrderIssueDirty = false;
  if (!sameBatch) {
    state.materialTraceData = null;
    state.materialTraceExpandedWorkOrders = {};
    state.materialTraceScrollTop = 0;
  }
  renderOrderDetail();
  focusOrderDetail({ resetScroll: !sameBatch });
  await refreshMaterialBatchTrace({ silent: false });
}

function openMaterialTraceWorkOrder(workOrderId) {
  if (!state.materialTraceOpen || !workOrderId) return;
  const order = state.data?.workOrders?.find((item) => item.id === workOrderId);
  if (!order) {
    showToast("关联工单不存在或已不可用");
    return;
  }
  captureMaterialTraceScroll();
  state.materialTraceView = "order";
  state.selectedOrderId = workOrderId;
  state.orderEditorMode = "edit";
  state.orderDrawerMode = "detail";
  state.orderFormDirty = false;
  state.orderFormInitialSnapshot = "";
  state.workOrderIssueFormOpen = false;
  state.workOrderIssueDirty = false;
  renderOrderDetail();
  focusOrderDetail({ resetScroll: true });
}

function returnToMaterialTrace() {
  if (!state.materialTraceOpen) return;
  state.materialTraceView = "trace";
  state.selectedOrderId = state.materialTraceReturnOrderId || state.selectedOrderId;
  state.orderEditorMode = "edit";
  state.orderDrawerMode = "trace";
  state.orderFormDirty = false;
  state.orderFormInitialSnapshot = "";
  state.workOrderIssueFormOpen = false;
  state.workOrderIssueDirty = false;
  renderOrderDetail();
  restoreMaterialTraceScroll();
}

function updateOrderWorkspaceVisibility() {
  const detailPanel = document.getElementById("order-detail-panel");
  const backdrop = document.getElementById("order-detail-backdrop");
  const showDetail = state.orderFocusMode || state.orderEditorMode === "create";
  detailPanel.classList.toggle("hidden", !showDetail);
  detailPanel.setAttribute("aria-hidden", String(!showDetail));
  backdrop.classList.toggle("hidden", !showDetail);
}

function hasUnsavedOrderChanges() {
  return state.orderFormDirty && (state.orderDrawerMode === "edit" || state.orderEditorMode === "create");
}

function confirmDiscardOrderChanges() {
  if (state.orderSaving) {
    showToast("工单正在保存，请稍候");
    return false;
  }
  return !hasUnsavedOrderChanges() || window.confirm("当前工单有未保存修改，确认放弃这些修改吗？");
}

function lockOrderListScroll() {
  if (state.orderScrollLocked) return;
  state.orderListScrollY = window.scrollY;
  state.orderScrollLocked = true;
  document.body.style.top = `-${state.orderListScrollY}px`;
  document.body.classList.add("order-drawer-open");
}

function unlockOrderListScroll() {
  if (!state.orderScrollLocked) return;
  const scrollY = state.orderListScrollY;
  state.orderScrollLocked = false;
  document.body.classList.remove("order-drawer-open");
  document.body.style.top = "";
  window.requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "auto" }));
}

function focusOrderDetail({ resetScroll = true } = {}) {
  state.orderFocusMode = true;
  updateOrderWorkspaceVisibility();
  lockOrderListScroll();
  window.requestAnimationFrame(() => {
    const drawerScroll = document.getElementById("order-drawer-scroll");
    if (drawerScroll && resetScroll) drawerScroll.scrollTop = 0;
    document.getElementById("close-order-detail-btn")?.focus({ preventScroll: true });
  });
}

function leaveOrderFocusMode() {
  const wasCreating = state.orderEditorMode === "create";
  const wasMaterialTraceOpen = state.materialTraceOpen;
  const traceReturnOrderId = state.materialTraceReturnOrderId;
  captureMaterialTraceScroll();
  if (wasMaterialTraceOpen) {
    state.materialTraceRequestVersion += 1;
    state.materialTraceOpen = false;
    state.materialTraceBatchId = "";
    state.materialTraceData = null;
    state.materialTraceLoading = false;
    state.materialTraceError = "";
    state.materialTraceExpandedWorkOrders = {};
    state.materialTraceView = "trace";
    state.materialTraceReturnOrderId = "";
    state.materialTraceScrollTop = 0;
    if (traceReturnOrderId) state.selectedOrderId = traceReturnOrderId;
  }
  state.orderFocusMode = false;
  state.workOrderIssueFormOpen = false;
  state.workOrderIssueDirty = false;
  state.orderDrawerMode = "detail";
  state.orderFormDirty = false;
  state.orderFormInitialSnapshot = "";
  state.orderSaving = false;
  state.orderEditorMode = "edit";
  if (wasCreating) state.selectedOrderId = state.orderBeforeCreateId || state.data?.workOrders?.[0]?.id || "";
  if (!state.selectedOrderId) state.selectedOrderId = state.data?.workOrders?.[0]?.id || "";
  renderOrders();
  renderOrderDetail();
  updateOrderWorkspaceVisibility();
  unlockOrderListScroll();
  window.requestAnimationFrame(() => {
    document.querySelector(`[data-order-id="${CSS.escape(state.selectedOrderId)}"]`)?.focus({ preventScroll: true });
  });
}

function requestCloseOrderDrawer() {
  if (!confirmDiscardOrderChanges()) return false;
  leaveOrderFocusMode();
  return true;
}

function startOrderEditing() {
  if (state.orderEditorMode !== "edit" || !state.selectedOrderId) return;
  state.orderDrawerMode = "edit";
  state.orderFormDirty = false;
  state.orderFormInitialSnapshot = "";
  state.workOrderIssueFormOpen = false;
  renderOrderDetail();
}

function cancelOrderEditing() {
  if (!confirmDiscardOrderChanges()) return;
  if (state.orderEditorMode === "create") {
    leaveOrderFocusMode();
    return;
  }
  state.orderDrawerMode = "detail";
  state.orderFormDirty = false;
  state.orderFormInitialSnapshot = "";
  renderOrderDetail();
  if (state.pendingAutoRefresh) runAutoRefresh();
}

function renderOrders() {
  updateOrderWorkspaceVisibility();
  renderWorkOrderStatusFilters();
  const filteredOrders = state.data.workOrders.filter((order) => matchesOrderFilter(order, state.orderFilter));
  const pagination = getPaginationModel(filteredOrders.length, orderPageSize, state.orderPage);
  state.orderPage = pagination.page;
  const visibleOrders = filteredOrders.slice(pagination.start, pagination.end);
  document.getElementById("order-table").innerHTML = filteredOrders.length
    ? `
      <div class="order-execution-list">
        ${visibleOrders
          .map((order) => {
            const quality = getWorkOrderQualitySummary(order);
            const progress = getProcessProgressSummary(order);
            const statusText = getOrderDisplayStatus(order, quality);
            return `
              <button class="order-execution-card ${order.id === state.selectedOrderId && state.orderEditorMode === "edit" ? "active" : ""}" type="button" data-order-id="${escapeHtml(order.id)}">
                <div class="order-execution-head">
                  <div class="order-identity">
                    <strong>${escapeHtml(order.id || "未编号")}</strong>
                    <span title="${escapeHtml(order.product || "未填写产品")}">${escapeHtml(order.product || "未填写产品")}</span>
                  </div>
                  <div class="order-badges">
                    ${["高", "加急"].includes(order.priority) ? '<span class="priority-badge">加急</span>' : ""}
                    <span class="status ${normalizeStatus(quality.hasFinalShortage ? "延期" : order.status)}">${escapeHtml(statusText)}</span>
                  </div>
                </div>
                <div class="order-metric-grid">
                  <div><span>计划</span><strong>${Number(order.plannedQty || 0)}</strong></div>
                  <div><span>成品良品</span><strong>${quality.finishedGoodQty}</strong></div>
                  <div><span>当前可流转</span><strong>${quality.currentTransferableGoodQty}</strong></div>
                  <div><span>累计报工</span><strong>${quality.completedQty}</strong></div>
                  <div><span>累计不良</span><strong class="${quality.badQty > 0 ? "danger-text" : ""}">${quality.badQty}</strong></div>
                  <div><span>过程不良率</span><strong>${quality.badRate === null ? "暂无" : `${quality.badRate.toFixed(1)}%`}</strong></div>
                </div>
                <div class="order-context-row">
                  <span>当前工序：<strong>${escapeHtml(order.currentProcess || "未配置工序")}</strong></span>
                  ${renderDueDateBadge(order)}
                  <span class="label-state">${order.id ? "二维码 / 标签已配置" : "未生成标签"}</span>
                  ${quality.hasFinalShortage ? `<span class="shortage-badge">最终良品少于计划 ${quality.shortageQty}</span>` : ""}
                </div>
                ${renderProcessProgress(order, true)}
                <div class="order-execution-foot">
                  <span>成品 ${quality.finishedGoodQty}/${Number(order.plannedQty || 0)}</span>
                  <span>可流转 ${quality.currentTransferableGoodQty}</span>
                  <span>工序 ${progress.completed}/${progress.total || 0}</span>
                </div>
              </button>
            `;
          })
          .join("")}
      </div>
      ${renderPaginationHtml("orders", filteredOrders.length, pagination)}
    `
    : `<div class="empty-state">当前筛选下没有工单。</div>`;

  document.getElementById("order-table").querySelectorAll("[data-order-id]").forEach((row) => {
    row.addEventListener("click", () => {
      if (!confirmDiscardOrderChanges()) return;
      state.selectedOrderId = row.getAttribute("data-order-id");
      state.orderEditorMode = "edit";
      state.orderDrawerMode = "detail";
      state.orderFormDirty = false;
      state.orderFormInitialSnapshot = "";
      state.workOrderIssueFormOpen = false;
      renderOrders();
      renderOrderDetail();
      focusOrderDetail();
    });
  });
  bindPagination(document.getElementById("order-table"), "orders", (page) => {
    state.orderPage = page;
    renderOrders();
    document.getElementById("order-list-panel")?.scrollIntoView({ block: "start", behavior: "auto" });
  });
}

function updateOrderDrawerChrome(order, showEditor) {
  ensureOrderDrawerPlacement();
  const title = document.getElementById("order-editor-title");
  const modeLabel = document.getElementById("order-drawer-mode-label");
  const status = document.getElementById("order-drawer-status");
  const editButton = document.getElementById("edit-order-btn");
  const cancelButton = document.getElementById("cancel-order-edit-btn");
  const footer = document.getElementById("order-drawer-footer");
  const saveButton = document.getElementById("order-save-btn");
  const isCreating = state.orderEditorMode === "create";
  const backButton = ensureMaterialTraceBackButton();
  const isMaterialTrace = state.materialTraceOpen && state.orderDrawerMode === "trace";
  const isMaterialTraceOrder = state.materialTraceOpen && state.materialTraceView === "order" && state.orderDrawerMode === "detail";

  if (isMaterialTrace) {
    title.textContent = `批次追溯 · ${state.materialTraceData?.batch?.batchNo || state.materialTraceBatchId || "加载中"}`;
    modeLabel.textContent = "批次追溯";
    status.textContent = state.materialTraceLoading ? "正在更新" : "只读";
    status.className = `status ${state.materialTraceLoading ? "pending" : "running"}`;
    status.classList.remove("hidden");
    editButton.classList.add("hidden");
    cancelButton.classList.add("hidden");
    backButton.classList.add("hidden");
    footer.classList.add("hidden");
    saveButton.disabled = true;
    return;
  }

  title.textContent = isCreating
    ? "新建生产单"
    : showEditor
      ? `编辑工单 · ${order?.id || ""}`
      : `${order?.id || "未选择工单"} · ${order?.product || "未填写产品"}`;
  modeLabel.textContent = isCreating ? "新建工单" : showEditor ? "工单编辑" : "工单详情";
  status.textContent = isCreating ? "待保存" : order?.status || "当前状态";
  status.className = `status ${normalizeStatus(isCreating ? "待开始" : order?.status || "待开始")}`;
  status.classList.toggle("hidden", showEditor);
  editButton.classList.toggle("hidden", showEditor || !order);
  cancelButton.classList.toggle("hidden", !showEditor);
  footer.classList.toggle("hidden", !showEditor);
  saveButton.textContent = state.orderSaving ? "正在保存..." : isCreating ? "保存生产单" : "保存工单";
  saveButton.disabled = state.orderSaving;
  backButton.classList.toggle("hidden", !isMaterialTraceOrder || showEditor);
}

function snapshotOrderForm(form) {
  return JSON.stringify(Array.from(new FormData(form).entries()));
}

function renderOrderDetail() {
  if (state.materialTraceOpen && state.orderDrawerMode === "trace") {
    updateOrderDrawerChrome(null, false);
    renderMaterialTraceDrawer();
    return;
  }
  const order = state.orderEditorMode === "edit" ? getSelectedOrder() : null;
  const showEditor = state.orderEditorMode === "create" || state.orderDrawerMode === "edit";
  updateOrderDrawerChrome(order, showEditor);
  const draft = makeOrderDraft(order || {});
  const root = document.getElementById("order-detail");
  const workOrderCode = buildWorkOrderCode(order);
  const workOrderLink = buildMobileWorkOrderLink(order);
  const workOrderLabelLink = buildWorkOrderLabelLink(order);
  const quality = order ? getWorkOrderQualitySummary(order) : null;
  const dueRisk = order ? getDueDateRisk(order) : null;
  const orderLocalOnlyNote = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(window.location.origin)
    ? '<div class="item-note">当前是 localhost，本机点链接没问题；真机扫码要换成局域网地址或线上域名。</div>'
    : "";

  root.innerHTML = `
    <div class="detail-stack">
      ${
        order && !showEditor
          ? `
            <div class="detail-card">
              <div class="detail-block execution-overview">
                <div class="execution-overview-head">
                  <div>
                    <div class="detail-title">生产执行概览</div>
                    <strong>${escapeHtml(order.id || "未编号")} · ${escapeHtml(order.product || "未填写产品")}</strong>
                    <div class="item-meta">样品单：${escapeHtml(order.sampleId || "未关联")} · 当前工序：${escapeHtml(order.currentProcess || "未配置")} · 建单时间：${escapeHtml(formatDateTime(order.createdAt))}</div>
                  </div>
                  <div class="order-badges">
                    ${["高", "加急"].includes(order.priority) ? '<span class="priority-badge">加急</span>' : ""}
                    <span class="status ${normalizeStatus(quality.hasFinalShortage ? "延期" : order.status)}">${escapeHtml(getOrderDisplayStatus(order, quality))}</span>
                    <span class="due-badge ${dueRisk.key}">${escapeHtml(dueRisk.label)}</span>
                  </div>
                </div>
                <div class="execution-kpis">
                  <div><span>计划数量</span><strong>${Number(order.plannedQty || 0)}</strong></div>
                  <div><span>成品良品</span><strong>${quality.finishedGoodQty}</strong></div>
                  <div><span>当前可流转</span><strong>${quality.currentTransferableGoodQty}</strong></div>
                  <div><span>累计报工</span><strong>${quality.completedQty}</strong></div>
                  <div><span>累计不良</span><strong class="${quality.badQty > 0 ? "danger-text" : ""}">${quality.badQty}</strong></div>
                  <div><span>过程不良率</span><strong>${quality.badRate === null ? "暂无" : `${quality.badRate.toFixed(1)}%`}</strong></div>
                </div>
                ${quality.hasFinalShortage ? `<div class="shortage-alert">流程已完成，但最终良品比计划少 ${quality.shortageQty}，请确认补产、返工或按短缺完结。</div>` : ""}
                <div class="progress-row">
                  <div class="progress-label"><span>成品产出</span><span>${quality.finishedGoodQty}/${Number(order.plannedQty || 0)}</span></div>
                  <div class="progress-bar"><div class="progress-fill" style="width:${percent(quality.finishedGoodQty, order.plannedQty)}%"></div></div>
                </div>
              </div>
              <div class="detail-block">
                <div class="detail-title">工艺路线 / 工序进度</div>
                ${renderProcessProgress(order)}
              </div>
              <div class="detail-block">
                <div class="panel-head compact-head">
                  <h2>报工记录</h2>
                  ${renderQualityBadge(order)}
                </div>
                ${renderWorkOrderReportHistory(order)}
              </div>
              <div class="detail-block">
                <div class="panel-head compact-head">
                  <div>
                    <h2>领料批次</h2>
                    <div class="item-note">领料消耗库存；报工记录生产进度。</div>
                  </div>
                  <div class="panel-actions">
                    <span class="badge">${getWorkOrderMaterialIssues(order.id).length} 笔</span>
                    <button class="primary-btn slim-btn" type="button" id="open-work-order-issue-btn" ${state.workOrderIssueFormOpen ? "disabled" : ""}>新增领料</button>
                  </div>
                </div>
                ${renderWorkOrderMaterialIssueHistory(order)}
                ${renderWorkOrderIssueForm(order)}
              </div>
              <div class="detail-block">
                <div class="panel-head">
                  <h2>工单二维码</h2>
                  <div class="panel-actions">
                    <button class="ghost-btn slim-btn" id="copy-workorder-code-btn" type="button">复制工单码</button>
                    <button class="ghost-btn slim-btn" id="copy-workorder-link-btn" type="button">复制扫码链接</button>
                    <a class="ghost-btn slim-btn" href="${escapeHtml(workOrderLabelLink)}" target="_blank" rel="noreferrer">查看标签页</a>
                  </div>
                </div>
                <div class="detail-title">工单码</div>
                <div class="code-block">${escapeHtml(workOrderCode)}</div>
                <div class="detail-title">工人扫码链接</div>
                <div class="code-block">${escapeHtml(workOrderLink)}</div>
                <div class="item-note">工人扫这张码会直接进入手机端报工页；仓库扫码物料时走的是另外一条批次码链路，不会混在一起。</div>
                ${orderLocalOnlyNote}
              </div>
            </div>
          `
          : ""
      }
      ${showEditor ? `
      <form class="editor-form order-editor-form" id="order-form">
        <div class="detail-block">
          <div class="detail-title">${order ? `当前工单：${escapeHtml(order.id)}` : "编号保存后自动生成"}</div>
          <div class="item-note">建单时间：${escapeHtml(formatDateTime(order?.createdAt))}</div>
          <div class="editor-grid two">
            <label>
              关联样品单
              <select name="sampleId">
                ${renderOptions(state.data.samples.map((item) => item.id), draft.sampleId, "不关联样品单")}
              </select>
            </label>
            <label>
              产品名称
              <input name="product" value="${escapeHtml(draft.product)}" placeholder="例如：运动减震鞋垫" required />
            </label>
          </div>
          <div class="editor-grid three">
            <label>
              计划数量
              <input name="plannedQty" type="number" min="1" step="1" value="${escapeHtml(draft.plannedQty)}" required />
            </label>
            <label>
              已完工数量
              <input name="doneQty" type="number" min="0" step="1" value="${escapeHtml(draft.doneQty)}" />
            </label>
            <label>
              交期
              <input name="dueAt" type="date" value="${escapeHtml(draft.dueAt)}" />
            </label>
          </div>
          <div class="editor-grid three">
            <label>
              当前工序
              <input name="currentProcess" value="${escapeHtml(draft.currentProcess)}" placeholder="例如：备料" required />
            </label>
            <label>
              优先级
              <select name="priority">${renderOptions(priorities, draft.priority)}</select>
            </label>
            <label>
              状态
              <select name="status">${renderOptions(orderStatuses, draft.status)}</select>
            </label>
          </div>
        </div>
        <div class="detail-block">
          <label>
            工艺路线
            <textarea name="routeText" placeholder="每行一个工序，格式：工序名|状态">${escapeHtml(draft.routeText)}</textarea>
          </label>
          <p class="helper-text">建议一行一个工序，例如：备料|待开始、裁切 / 开料|待开始。</p>
        </div>
      </form>
      ` : ""}
    </div>
  `;

  const orderForm = document.getElementById("order-form");
  if (orderForm) {
    state.orderFormInitialSnapshot = snapshotOrderForm(orderForm);
    state.orderFormDirty = false;
    const updateDirtyState = () => {
      state.orderFormDirty = snapshotOrderForm(orderForm) !== state.orderFormInitialSnapshot;
    };
    orderForm.addEventListener("input", updateDirtyState);
    orderForm.addEventListener("change", updateDirtyState);
    orderForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.orderSaving) return;
      const formData = new FormData(orderForm);
      const payload = {
        sampleId: formData.get("sampleId"),
        product: formData.get("product"),
        plannedQty: Number(formData.get("plannedQty")),
        doneQty: Number(formData.get("doneQty") || 0),
        currentProcess: formData.get("currentProcess"),
        priority: formData.get("priority"),
        status: formData.get("status"),
        dueAt: formData.get("dueAt"),
        route: parseRouteText(formData.get("routeText")),
      };
      state.orderSaving = true;
      updateOrderDrawerChrome(order, true);
      try {
        const mode = state.orderEditorMode;
        const result =
          mode === "create"
            ? await api("/api/work-orders", { method: "POST", body: JSON.stringify(payload) })
            : await api(`/api/work-orders/${encodeURIComponent(state.selectedOrderId)}`, { method: "PUT", body: JSON.stringify(payload) });
        state.data = result.state;
        state.selectedOrderId = result.workOrder.id;
        state.orderEditorMode = "edit";
        state.orderDrawerMode = "detail";
        state.orderFormDirty = false;
        state.orderFormInitialSnapshot = "";
        state.orderSaving = false;
        syncSelections();
        renderAll();
        showToast(mode === "create" ? "生产单已新建" : "生产单已更新");
      } catch (error) {
        state.orderSaving = false;
        updateOrderDrawerChrome(order, true);
        showToast(error.message);
      }
    });
  }

  const copyWorkOrderCodeButton = document.getElementById("copy-workorder-code-btn");
  if (copyWorkOrderCodeButton && order) {
    copyWorkOrderCodeButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(workOrderCode);
        showToast("工单码已复制");
      } catch {
        showToast("复制失败，请手动复制工单码");
      }
    });
  }

  const copyWorkOrderLinkButton = document.getElementById("copy-workorder-link-btn");
  if (copyWorkOrderLinkButton && order) {
    copyWorkOrderLinkButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(workOrderLink);
        showToast("扫码链接已复制");
      } catch {
        showToast("复制失败，请手动复制链接");
      }
    });
  }

  const openWorkOrderIssueButton = document.getElementById("open-work-order-issue-btn");
  if (openWorkOrderIssueButton && order) {
    openWorkOrderIssueButton.addEventListener("click", () => {
      state.workOrderIssueFormOpen = true;
      state.workOrderIssueDirty = false;
      state.workOrderIssueDraft = { materialCode: "", batchNo: "", qty: "1" };
      renderOrderDetail();
      if (state.pendingAutoRefresh) runAutoRefresh();
    });
  }

  const workOrderIssueForm = document.getElementById("work-order-issue-form");
  if (workOrderIssueForm && order) {
    const materialSelect = document.getElementById("work-order-issue-material");
    const batchSelect = document.getElementById("work-order-issue-batch");
    const qtyInput = document.getElementById("work-order-issue-qty");
    workOrderIssueForm.addEventListener("input", () => { state.workOrderIssueDirty = true; });
    workOrderIssueForm.addEventListener("change", () => { state.workOrderIssueDirty = true; });

    materialSelect?.addEventListener("change", () => {
      state.workOrderIssueDraft = {
        materialCode: materialSelect.value,
        batchNo: "",
        qty: qtyInput?.value || "1",
      };
      renderOrderDetail();
    });
    batchSelect?.addEventListener("change", () => {
      state.workOrderIssueDraft = {
        materialCode: materialSelect?.value || "",
        batchNo: batchSelect.value,
        qty: qtyInput?.value || "1",
      };
      refreshWorkOrderIssueFefoPreview();
    });
    qtyInput?.addEventListener("input", () => {
      state.workOrderIssueDraft = {
        materialCode: materialSelect?.value || "",
        batchNo: batchSelect?.value || "",
        qty: qtyInput.value || "1",
      };
      refreshWorkOrderIssueFefoPreview();
    });

    document.getElementById("cancel-work-order-issue-btn")?.addEventListener("click", () => {
      state.workOrderIssueFormOpen = false;
      state.workOrderIssueDirty = false;
      state.workOrderIssueDraft = { materialCode: "", batchNo: "", qty: "1" };
      renderOrderDetail();
    });

    workOrderIssueForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(workOrderIssueForm);
      const materialCode = String(formData.get("materialCode") || "");
      const batchNo = String(formData.get("batchNo") || "");
      const qty = Number(formData.get("qty") || 0);
      const selectedBatch = getMaterialBatches().find((item) => item.materialCode === materialCode && item.batchNo === batchNo) || null;
      const advice = buildFefoAdvice(selectedBatch, qty);
      const overrideReason = String(formData.get("overrideReason") || "").trim();
      if (advice.reasonRequired && !overrideReason) {
        showToast("当前批次不符合 FEFO 或已过期，请填写原因");
        return;
      }
      const submitButton = workOrderIssueForm.querySelector('button[type="submit"]');
      if (submitButton?.disabled) return;
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "正在领料...";
      }
      try {
        const result = await api(`/api/work-orders/${encodeURIComponent(order.id)}/material-issues`, {
          method: "POST",
          body: JSON.stringify({
            materialCode,
            batchNo,
            qty,
            note: String(formData.get("note") || "").trim(),
            overrideReason,
          }),
        });
        state.data = result.state;
        state.workOrderIssueFormOpen = false;
        state.workOrderIssueDirty = false;
        state.workOrderIssueDraft = { materialCode: "", batchNo: "", qty: "1" };
        syncSelections();
        renderAll();
        showToast(`${order.id} 领料成功，库存与流水已同步`);
      } catch (error) {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = "确认领料";
        }
        showToast(error.message);
      }
    });
  }
}

function hasUnsavedMaterialDrawerChanges() {
  return state.materialDrawerDirty && Boolean(state.materialDrawerMode);
}

function confirmDiscardMaterialDrawerChanges() {
  if (state.materialDrawerSaving) {
    showToast("正在保存，请稍候");
    return false;
  }
  return !hasUnsavedMaterialDrawerChanges() || window.confirm("当前表单有未保存修改，确认放弃这些修改吗？");
}

function closeMaterialDrawer({ force = false } = {}) {
  if (!force && !confirmDiscardMaterialDrawerChanges()) return false;
  state.materialDrawerMode = "";
  state.materialDrawerDirty = false;
  state.materialDrawerInitialSnapshot = "";
  state.materialDrawerSaving = false;
  document.getElementById("material-drawer")?.classList.add("hidden");
  document.getElementById("material-drawer")?.setAttribute("aria-hidden", "true");
  document.getElementById("material-drawer-backdrop")?.classList.add("hidden");
  unlockOrderListScroll();
  if (state.pendingAutoRefresh && !force) {
    state.pendingAutoRefresh = false;
    loadState({ source: "auto", force: true });
  }
  if (force) state.pendingAutoRefresh = false;
  return true;
}

function renderMaterialDrawer() {
  const drawer = document.getElementById("material-drawer");
  const content = document.getElementById("material-drawer-content");
  const title = document.getElementById("material-drawer-title");
  const eyebrow = document.getElementById("material-drawer-eyebrow");
  const saveButton = document.getElementById("save-material-drawer-btn");
  const mode = state.materialDrawerMode;
  const material = getMaterialItems().find((item) => item.code === state.materialDrawerMaterialCode) || getSelectedMaterialItem();
  if (!mode) return;
  const isBatch = mode === "batch";
  drawer.classList.toggle("batch-drawer", isBatch);
  title.textContent = isBatch ? "新建批次并入库" : "新建物料档案";
  eyebrow.textContent = isBatch ? "批次入库" : "物料档案";
  saveButton.textContent = state.materialDrawerSaving ? "正在保存..." : isBatch ? "创建批次并入库" : "保存物料档案";
  saveButton.disabled = state.materialDrawerSaving;
  saveButton.setAttribute("form", isBatch ? "material-drawer-batch-form" : "material-drawer-item-form");
  const now = new Date();
  const todayValue = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const expiry = new Date(now);
  expiry.setDate(expiry.getDate() + 30);
  const expiryValue = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, "0")}-${String(expiry.getDate()).padStart(2, "0")}`;
  content.innerHTML = isBatch
    ? `
      <form class="editor-form business-drawer-form" id="material-drawer-batch-form" autocomplete="off">
        <div class="drawer-current-material"><span>当前物料</span><strong>${escapeHtml(material?.code || "-")} · ${escapeHtml(material?.name || "未选择物料")}</strong></div>
        <input name="materialCode" type="hidden" value="${escapeHtml(material?.code || "")}" />
        <div class="editor-grid two">
          <label>批次号<input name="batchNoDraft" autocomplete="new-password" placeholder="例如：PU-202607-001" required /></label>
          <label>入库数量（单位：${escapeHtml(materialUnitLabel(material))}）<input name="initialQty" type="number" min="0.001" step="any" value="1" required /></label>
          <label>来料日期<input name="receivedDate" type="date" value="${todayValue}" required /></label>
          <label>保质期截止日期<input name="expiryDate" type="date" value="${expiryValue}" required /></label>
          <label>库位<input name="locationDraft" autocomplete="new-password" value="${escapeHtml(material?.defaultLocation || "")}" required /></label>
          <label>供应商<input name="supplierDraft" autocomplete="new-password" value="${escapeHtml(material?.supplier || "")}" placeholder="可选" /></label>
        </div>
        <label>备注<textarea name="batchNoteDraft" autocomplete="new-password" rows="3" placeholder="可选，例如采购到货"></textarea></label>
      </form>
    `
    : `
      <form class="editor-form business-drawer-form" id="material-drawer-item-form" autocomplete="off">
        <div class="editor-grid two">
          <label>物料编号<input name="code" placeholder="例如：RM-PU-001" required /></label>
          <label>物料名称<input name="name" placeholder="例如：PU 原材料" required /></label>
          <label>规格<input name="spec" placeholder="例如：低温热塑" /></label>
          <label>计量单位<input name="unit" value="kg" list="drawer-material-unit-options" placeholder="kg、张、片、桶、个" required /></label>
          <label>安全库存<input name="safetyQty" type="number" min="0" step="any" value="0" required /></label>
          <label>默认库位<input name="defaultLocation" placeholder="例如：A-01" /></label>
          <label>供应商<input name="supplier" placeholder="可选" /></label>
          <label>状态<select name="status"><option value="启用">启用</option><option value="停用">停用</option></select></label>
        </div>
        <datalist id="drawer-material-unit-options"><option value="kg"></option><option value="张"></option><option value="片"></option><option value="桶"></option><option value="个"></option><option value="双"></option><option value="米"></option></datalist>
      </form>
    `;
  const form = content.querySelector("form");
  state.materialDrawerInitialSnapshot = snapshotOrderForm(form);
  state.materialDrawerDirty = false;
  const updateDirty = () => {
    state.materialDrawerDirty = snapshotOrderForm(form) !== state.materialDrawerInitialSnapshot;
  };
  form.addEventListener("input", updateDirty);
  form.addEventListener("change", updateDirty);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.materialDrawerSaving) return;
    const formData = new FormData(form);
    state.materialDrawerSaving = true;
    saveButton.disabled = true;
    saveButton.textContent = "正在保存...";
    try {
      if (isBatch) {
        const result = await api("/api/material-batches", { method: "POST", body: JSON.stringify({
          materialCode: formData.get("materialCode"), batchNo: formData.get("batchNoDraft"), initialQty: Number(formData.get("initialQty") || 0),
          location: formData.get("locationDraft"), receivedDate: formData.get("receivedDate"), expiryDate: formData.get("expiryDate"),
          supplier: formData.get("supplierDraft"), note: formData.get("batchNoteDraft"),
        }) });
        state.data = result.state;
        state.selectedMaterialCode = result.batch.materialCode;
        state.selectedMaterialKey = materialKey(result.batch);
        state.batchPinnedKey = state.selectedMaterialKey;
        state.batchPage = 1;
        state.movementPage = 1;
        state.movementNewHint = false;
        closeMaterialDrawer({ force: true });
        syncSelections();
        renderAll();
        showToast("批次已创建并入库");
      } else {
        const payload = { code: String(formData.get("code") || "").trim(), name: formData.get("name"), spec: formData.get("spec"), unit: formData.get("unit") || "kg", safetyQty: Number(formData.get("safetyQty") || 0), defaultLocation: formData.get("defaultLocation"), supplier: formData.get("supplier"), status: formData.get("status") };
        if (isNumericText(payload.unit)) throw new Error("计量单位请填 kg、张、片等文字");
        const result = await api("/api/material-items/save", { method: "POST", body: JSON.stringify(payload) });
        state.data = result.state;
        state.selectedMaterialCode = result.material.code;
        state.selectedMaterialKey = "";
        state.batchPage = 1;
        state.movementPage = 1;
        closeMaterialDrawer({ force: true });
        syncSelections();
        renderAll();
        showToast("物料档案已创建");
      }
    } catch (error) {
      state.materialDrawerSaving = false;
      saveButton.disabled = false;
      saveButton.textContent = isBatch ? "创建批次并入库" : "保存物料档案";
      showToast(error.message);
    }
  });
  disableBrowserSuggestions();
}

function openMaterialDrawer(mode) {
  if (state.orderFocusMode && !requestCloseOrderDrawer()) return;
  if (state.materialDrawerMode && !closeMaterialDrawer()) return;
  if (mode === "batch" && !getSelectedMaterialItem()) {
    showToast("请先选择物料档案");
    return;
  }
  state.materialDrawerMode = mode;
  state.materialDrawerMaterialCode = state.selectedMaterialCode;
  state.materialDrawerDirty = false;
  state.materialDrawerSaving = false;
  document.getElementById("material-drawer")?.classList.remove("hidden");
  document.getElementById("material-drawer")?.setAttribute("aria-hidden", "false");
  document.getElementById("material-drawer-backdrop")?.classList.remove("hidden");
  renderMaterialDrawer();
  lockOrderListScroll();
  document.getElementById("close-material-drawer-btn")?.focus({ preventScroll: true });
}

function renderMaterials() {
  const materialItems = getMaterialItems();
  const selectedMaterialItem = getSelectedMaterialItem();
  const materialBatches = getMaterialBatches();
  const selectedBatches = selectedMaterialItem ? materialBatches.filter((item) => item.materialCode === selectedMaterialItem.code) : [];
  const filteredSelectedBatches = selectedBatches.filter((item) => matchesBatchFilter(item));
  if (state.batchPinnedKey) {
    filteredSelectedBatches.sort((a, b) => Number(materialKey(b) === state.batchPinnedKey) - Number(materialKey(a) === state.batchPinnedKey));
  }
  const batchPagination = getPaginationModel(filteredSelectedBatches.length, batchPageSize, state.batchPage);
  state.batchPage = batchPagination.page;
  const visibleBatches = filteredSelectedBatches.slice(batchPagination.start, batchPagination.end);
  const selectedBatch = getSelectedMaterial() || selectedBatches[0] || null;
  const selectedSummary = selectedMaterialItem ? getMaterialSummary(selectedMaterialItem.code) : null;
  const selectedUnit = materialUnitLabel(selectedMaterialItem);
  const filteredMaterialItems = getFilteredMaterialItems();
  const batchCode = buildMaterialBatchCode(selectedBatch);
  const batchLink = buildMobileBatchLink(selectedBatch);
  const batchLabelLink = buildBatchLabelLink(selectedBatch);
  const today = new Date();
  const todayValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const expiry = new Date(today);
  expiry.setDate(expiry.getDate() + 30);
  const defaultExpiryValue = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, "0")}-${String(expiry.getDate()).padStart(2, "0")}`;
  const localOnlyNote = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(window.location.origin)
    ? '<div class="item-note">当前是 localhost，本机点链接没问题，但真机扫码还需要部署上线，或者改成你电脑的局域网 IP 地址。</div>'
    : '';
  const allMovementRows = getSelectedBatchMovements();
  const movementPagination = getPaginationModel(allMovementRows.length, movementPageSize, state.movementPage);
  state.movementPage = movementPagination.page;
  const movementRows = allMovementRows.slice(movementPagination.start, movementPagination.end);

  document.getElementById("material-table").innerHTML = `
    <div class="panel-grid two-up material-layout">
      <section class="detail-stack">
        <div class="detail-block">
          <div class="panel-head">
            <h2>物料档案</h2>
            <div class="panel-actions">
              <span class="badge">${filteredMaterialItems.length}/${materialItems.length} 个物料</span>
              <button class="ghost-btn slim-btn" type="button" id="export-material-items-btn">导出物料档案</button>
              <button class="ghost-btn slim-btn" type="button" id="new-material-item-btn">+ 新建</button>
            </div>
          </div>
          <div class="filter-row" id="material-filter-row">
            ${materialFilterDefinitions
              .map((item) => `<button class="ghost-btn slim-btn ${state.materialFilter === item.key ? "active-filter" : ""}" type="button" data-material-filter="${escapeHtml(item.key)}">${escapeHtml(item.label)}</button>`)
              .join("")}
          </div>
          <div class="table">
            <div class="table-head material-master-grid">
              <div>料号</div><div>物料</div><div>规格</div><div>总库存</div><div>安全库存</div><div>最近到期</div><div>状态</div>
            </div>
            ${
              filteredMaterialItems
                .map((item) => {
                  const summary = getMaterialSummary(item.code);
                  const riskText = summary.lowStock
                    ? "低库存"
                    : Number(summary.expiredBatchCount || 0) > 0
                      ? "有过期"
                      : Number(summary.expiringSoonBatchCount || 0) > 0
                        ? "即将过期"
                        : escapeHtml(item.status || "启用");
                  const riskClass = summary.lowStock || Number(summary.expiredBatchCount || 0) > 0 ? "warn" : Number(summary.expiringSoonBatchCount || 0) > 0 ? "pending" : "running";
                  return `
                    <button class="table-row material-master-grid clickable ${item.code === selectedMaterialItem?.code ? "active" : ""}" data-material-code="${escapeHtml(item.code)}" type="button">
                      <div>${escapeHtml(item.code)}</div>
                      <div>${escapeHtml(item.name)}</div>
                      <div>${escapeHtml(item.spec || "-")}</div>
                      <div><span class="status ${summary.lowStock ? "warn" : ""}">${summary.totalStockQty} ${escapeHtml(materialUnitLabel(item))}</span></div>
                      <div>${summary.safetyQty} ${escapeHtml(materialUnitLabel(item))}</div>
                      <div>${escapeHtml(summary.nearestExpiryDate || "-")}</div>
                      <div><span class="status ${riskClass}">${escapeHtml(riskText)}</span></div>
                    </button>
                  `;
                })
                .join("") || '<div class="empty-state">暂无物料档案。</div>'
            }
          </div>
        </div>

        <div class="detail-block">
          <div class="panel-head">
            <h2>批次库存</h2>
            <div class="panel-actions">
              <span class="badge">${filteredSelectedBatches.length}/${selectedBatches.length} 个批次</span>
              <button class="ghost-btn slim-btn" type="button" id="export-material-batches-btn">导出批次库存</button>
              <button class="primary-btn slim-btn" type="button" id="new-material-batch-btn" ${selectedMaterialItem ? "" : "disabled"}>+ 新建批次 / 入库</button>
            </div>
          </div>
          <div class="filter-row batch-filter-row" id="batch-filter-row">
            ${materialFilterDefinitions
              .map((item) => `<button class="ghost-btn slim-btn ${state.batchFilter === item.key ? "active-filter" : ""}" type="button" data-batch-filter="${escapeHtml(item.key)}">${escapeHtml(item.label)}</button>`)
              .join("")}
          </div>
          <div class="table">
            <div class="table-head material-grid">
              <div>批次号</div><div>库存</div><div>初始</div><div>库位</div><div>来料</div><div>到期 / 状态</div><div>操作</div>
            </div>
            ${visibleBatches
              .map((item) => {
                const status = item.batchStatus || getBatchStatus(item);
                const days = item.daysUntilExpiry ?? daysUntilExpiry(item.expiryDate);
                const itemBatchCode = buildMaterialBatchCode(item);
                const itemLabelLink = buildBatchLabelLink(item);
                const itemPrintLink = `${itemLabelLink}${itemLabelLink.includes("?") ? "&" : "?"}print=1`;
                return `
                  <div class="table-row material-grid clickable ${materialKey(item) === materialKey(selectedBatch) ? "active" : ""}" data-material-key="${escapeHtml(materialKey(item))}">
                    <div>${escapeHtml(item.batchNo)}</div>
                    <div><span class="status ${status === "已过期" || status === "已用完" ? "warn" : ""}">${Number(item.stockQty || 0)} ${escapeHtml(selectedUnit)}</span></div>
                    <div>${Number(item.initialQty || 0)} ${escapeHtml(selectedUnit)}</div>
                    <div>${escapeHtml(item.location || "-")}</div>
                    <div>${escapeHtml(String(item.receivedDate || "").slice(0, 10) || "-")}</div>
                    <div>${escapeHtml(String(item.expiryDate || "").slice(0, 10) || "-")} / ${escapeHtml(formatExpiryDistance(days))} / <span class="status ${batchStatusClass(status)}">${escapeHtml(status)}</span></div>
                    <div class="row-actions">
                      <a class="ghost-btn micro-btn" href="${escapeHtml(itemLabelLink)}" target="_blank" rel="noreferrer" data-row-action="open">标签</a>
                      <a class="ghost-btn micro-btn" href="${escapeHtml(itemPrintLink)}" target="_blank" rel="noreferrer" data-row-action="print">打印</a>
                      <button class="ghost-btn micro-btn" type="button" data-copy-batch-code="${escapeHtml(itemBatchCode)}">复制</button>
                      <button class="ghost-btn micro-btn" type="button" data-trace-batch="${escapeHtml(item.id || materialKey(item))}">追溯</button>
                    </div>
                  </div>
                `;
              })
              .join("") || '<div class="empty-state">当前物料在此筛选下没有批次。</div>'}
          </div>
          ${renderPaginationHtml("batches", filteredSelectedBatches.length, batchPagination)}
        </div>

        <div class="detail-block">
          <div class="panel-head">
            <h2>出入库流水</h2>
            <div class="panel-actions">
              <span class="badge">${selectedBatch ? escapeHtml(selectedBatch.batchNo) : "批次记录"}</span>
              ${state.movementNewHint ? '<span class="inline-update-hint">有新的出入库记录</span>' : ""}
              <button class="ghost-btn slim-btn" type="button" id="export-stock-movements-btn">导出出入库流水</button>
            </div>
          </div>
          <div class="list">
            ${
              movementRows.length
                ? movementRows
                    .map(
                      (item) => {
                        const movementMaterial = getMaterialItems().find((entry) => entry.code === item.materialCode) || selectedMaterialItem || {};
                        const movementUnit = materialUnitLabel(movementMaterial);
                        const statusLabel = movementStatusLabel(item);
                        const sourceLabel = item.source === "work_order_issue" ? "来源：工单领料" : item.source === "correction" ? "来源：冲正" : "来源：普通出入库";
                        const workOrderLink = item.workOrderId
                          ? `<button class="ghost-btn micro-btn" type="button" data-open-work-order="${escapeHtml(item.workOrderId)}">关联工单：${escapeHtml(item.workOrderId)}</button>`
                          : "";
                        return `
                        <div class="list-item">
                          <div class="item-top">
                            <div class="item-title">${movementTypeLabel(item.type)} ${escapeHtml(item.qty)}${escapeHtml(movementUnit)}</div>
                            <span class="status ${movementStatusClass(item) || (item.type === "out" ? "warn" : "pending")}">${escapeHtml(statusLabel)}</span>
                          </div>
                           <div class="item-meta">物料：${escapeHtml(movementMaterial.name || item.materialCode)} / 批次：${escapeHtml(item.batchNo)} / 库位：${escapeHtml(item.location || "-")}</div>
                           <div class="item-meta">操作人：${escapeHtml(item.operator || "-")} / 时间：${escapeHtml(formatDateTime(item.createdAt))}</div>
                           <div class="item-note">${escapeHtml(sourceLabel)} ${workOrderLink}</div>
                           <div class="item-note">${escapeHtml([item.note, item.correctionReason ? `原因：${item.correctionReason}` : "", item.correctionOfMovementId ? `冲正原流水：${item.correctionOfMovementId}` : "", item.correctedByMovementId ? `关联冲正流水：${item.correctedByMovementId}` : ""].filter(Boolean).join("；") || "无备注")}</div>
                          ${
                            !item.correctedByMovementId && !item.correctionOfMovementId
                              ? `<div class="editor-actions compact-actions"><button class="ghost-btn slim-btn" type="button" data-correct-movement="${escapeHtml(item.id)}">冲正</button></div>`
                              : ""
                          }
                        </div>
                      `;
                      }
                    )
                    .join("")
                : '<div class="empty-state">当前批次还没有出入库记录。</div>'
            }
          </div>
          ${renderPaginationHtml("movements", allMovementRows.length, movementPagination)}
        </div>
      </section>

      <section class="detail-stack">
        <div class="detail-block">
          <div class="panel-head">
            <h2>物料档案维护</h2>
            <span class="badge">档案</span>
          </div>
          <form class="editor-form" id="material-item-form">
            <div class="editor-grid two">
                            <label>物料编号<input name="code" value="${escapeHtml(selectedMaterialItem?.code || "")}" placeholder="例如：RM-PU-001" required /></label>
              <label>物料名称<input name="name" value="${escapeHtml(selectedMaterialItem?.name || "")}" placeholder="例如：PU 原材料" required /></label>
              <label>规格<input name="spec" value="${escapeHtml(selectedMaterialItem?.spec || "")}" placeholder="例如：低温热塑" /></label>
              <label>计量单位（只填单位，不填数量）<input name="unit" value="${escapeHtml(selectedUnit)}" list="material-unit-options" placeholder="例如：kg、张、片、桶、个" required /></label>
              <label>当前总库存数量（单位：${escapeHtml(selectedUnit)}，只读）<input value="${escapeHtml(selectedSummary?.totalStockQty ?? 0)}" readonly /></label>
              <label>安全库存数量（单位：${escapeHtml(selectedUnit)}）<input name="safetyQty" type="number" min="0" step="1" value="${escapeHtml(selectedMaterialItem?.safetyQty ?? 0)}" required /></label>
              <label>默认库位<input name="defaultLocation" value="${escapeHtml(selectedMaterialItem?.defaultLocation || "")}" placeholder="例如：A-01" /></label>
            </div>
            <datalist id="material-unit-options">
              <option value="kg"></option>
              <option value="张"></option>
              <option value="片"></option>
              <option value="桶"></option>
              <option value="个"></option>
              <option value="双"></option>
              <option value="米"></option>
            </datalist>
            <div class="item-note">建档时间：${escapeHtml(formatDateTime(selectedMaterialItem?.createdAt))}</div>
            <div class="editor-actions">
              <button class="primary-btn" type="submit">保存物料档案</button>
              <button class="ghost-btn" type="button" id="new-material-draft-btn">清空新建</button>
            </div>
          </form>
        </div>

        <div class="detail-block">
          <div class="panel-head">
            <h2>当前批次与出入库</h2>
            <span class="badge ${selectedSummary?.lowStock ? "warn" : ""}">
              ${selectedSummary ? `${selectedSummary.totalStockQty} ${escapeHtml(selectedUnit)}` : "未选择物料"}
            </span>
          </div>
          ${
            selectedMaterialItem
              ? `
                <div class="detail-card">
                  <div class="detail-block">
                    <div class="detail-title">当前批次</div>
                    ${
                      selectedBatch
                        ? `
                          <div class="item-title">${escapeHtml(selectedMaterialItem.name)} / ${escapeHtml(selectedBatch.batchNo)}</div>
                          <div class="item-meta">${escapeHtml(selectedBatch.materialCode)} / ${escapeHtml(selectedBatch.location)} / 到期 ${escapeHtml(String(selectedBatch.expiryDate || "").slice(0, 10) || "-")} / ${escapeHtml(selectedBatch.supplier || selectedMaterialItem.supplier || "-")}</div>
                          <div class="item-note">建档时间：${escapeHtml(formatDateTime(selectedBatch.createdAt))}</div>
                        `
                        : '<div class="empty-state compact-empty">当前物料暂无批次，先新建一个批次。</div>'
                    }
                  </div>

                  ${
                    selectedBatch
                      ? `
                        <form class="editor-form" id="material-movement-form">
                          <div class="editor-grid two">
                            <label>
                              出入库类型
                              <select name="type">
                                <option value="in">入库</option>
                                <option value="out">出库</option>
                              </select>
                            </label>
                            <label>出入库数量（单位：${escapeHtml(selectedUnit)}）<input name="qty" type="number" min="1" step="1" value="1" required /></label>
                            <label>库位<input name="movementLocation" autocomplete="new-password" value="${escapeHtml(selectedBatch.location || "")}" required /></label>
                            <label>备注<input name="movementNote" autocomplete="new-password" placeholder="采购到货、领料、退料、盘点调整" /></label>
                          </div>
                          <div id="fefo-plan-preview">${renderFefoAdviceHtml(selectedBatch, 1)}</div>
                          <label class="override-reason-field" id="fefo-override-field">
                            不按 FEFO / 过期强制出库原因
                            <input name="overrideReason" autocomplete="new-password" placeholder="例如：研发试料、客户指定、异常处理" />
                          </label>
                          <div class="editor-actions">
                            <button class="primary-btn" type="submit">提交库存动作</button>
                          </div>
                        </form>
                      `
                      : ""
                  }

                  <div class="detail-block">
                    <div class="panel-head">
                      <h2>扫码批次码</h2>
                      <div class="panel-actions">
                        <button class="ghost-btn slim-btn" id="copy-batch-code-btn" type="button">复制批次码</button>
                        <button class="ghost-btn slim-btn" id="copy-batch-link-btn" type="button">复制扫码链接</button>
                        <a class="ghost-btn slim-btn" href="${escapeHtml(batchLabelLink)}" target="_blank" rel="noreferrer">查看标签页</a>
                        <a class="ghost-btn slim-btn" href="${escapeHtml(batchLabelLink)}${batchLabelLink.includes("?") ? "&" : "?"}print=1" target="_blank" rel="noreferrer">打印标签</a>
                      </div>
                    </div>
                    <div class="detail-title">批次码</div>
                    <div class="code-block">${escapeHtml(batchCode || "暂无批次")}</div>
                    <div class="detail-title">H5 扫码链接</div>
                    <div class="code-block">${escapeHtml(batchLink || "暂无批次")}</div>
                    <div class="item-note">批次码继续沿用 <code>MAT|料号|批次|库位</code>。新旧标签都能被手机端识别。</div>
                    ${localOnlyNote}
                  </div>
                </div>
              `
              : '<div class="empty-state">暂无物料档案，请先新建物料。</div>'
          }
        </div>
      </section>
    </div>
  `;

  document.querySelectorAll("[data-material-code]").forEach((row) => {
    row.addEventListener("click", () => {
      state.materialEditorMode = "edit";
      state.selectedMaterialCode = row.getAttribute("data-material-code");
      const firstBatch = getMaterialBatches().find((item) => item.materialCode === state.selectedMaterialCode);
      state.selectedMaterialKey = materialKey(firstBatch);
      state.batchPage = 1;
      state.movementPage = 1;
      state.movementNewHint = false;
      state.batchPinnedKey = "";
      renderMaterials();
    });
  });

  document.querySelectorAll("[data-material-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.materialFilter = button.getAttribute("data-material-filter") || "all";
      renderMaterials();
    });
  });

  document.querySelectorAll("[data-batch-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.batchFilter = button.getAttribute("data-batch-filter") || "all";
      state.batchPage = 1;
      state.batchPinnedKey = "";
      renderMaterials();
    });
  });

  document.getElementById("export-material-items-btn")?.addEventListener("click", exportMaterialItemsCsv);
  document.getElementById("export-material-batches-btn")?.addEventListener("click", exportMaterialBatchesCsv);
  document.getElementById("export-stock-movements-btn")?.addEventListener("click", exportStockMovementsCsv);

  const newMaterialItemButton = document.getElementById("new-material-item-btn");
  if (newMaterialItemButton) {
    newMaterialItemButton.addEventListener("click", () => openMaterialDrawer("material"));
  }
  document.getElementById("new-material-batch-btn")?.addEventListener("click", () => openMaterialDrawer("batch"));

  document.querySelectorAll("[data-material-key]").forEach((row) => {
    row.addEventListener("click", () => {
      state.materialEditorMode = "edit";
      state.selectedMaterialKey = row.getAttribute("data-material-key");
      state.batchPinnedKey = "";
      state.movementPage = 1;
      state.movementNewHint = false;
      renderMaterials();
    });
  });
  bindPagination(document.getElementById("material-table"), "batches", (page) => {
    state.batchPage = page;
    state.batchPinnedKey = "";
    renderMaterials();
  });
  bindPagination(document.getElementById("material-table"), "movements", (page) => {
    state.movementPage = page;
    state.movementNewHint = false;
    renderMaterials();
  });

  document.querySelectorAll("[data-row-action]").forEach((action) => {
    action.addEventListener("click", (event) => event.stopPropagation());
  });

  document.querySelectorAll("[data-trace-batch]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const batchId = button.getAttribute("data-trace-batch") || "";
      const batch = getMaterialBatches().find((item) => item.id === batchId || materialKey(item) === batchId);
      if (batch) openMaterialBatchTrace(batch);
    });
  });

  document.querySelectorAll("[data-copy-batch-code]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(button.getAttribute("data-copy-batch-code") || "");
        showToast("批次码已复制");
      } catch {
        showToast("复制失败，请手动复制批次码");
      }
    });
  });

  const copyButton = document.getElementById("copy-batch-code-btn");
  if (copyButton && selectedBatch) {
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(batchCode);
        showToast("批次码已复制，可到手机端直接粘贴");
      } catch {
        showToast("复制失败，请手动复制批次码");
      }
    });
  }

  const copyLinkButton = document.getElementById("copy-batch-link-btn");
  if (copyLinkButton && selectedBatch) {
    copyLinkButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(batchLink);
        showToast("扫码链接已复制");
      } catch {
        showToast("复制失败，请手动复制链接");
      }
    });
  }

  document.querySelectorAll("[data-correct-movement]").forEach((button) => {
    button.addEventListener("click", async () => {
      const movementId = button.getAttribute("data-correct-movement");
      const reason = window.prompt("请输入冲正原因。原流水会保留，系统会自动生成反向冲正流水。");
      if (reason === null) return;
      const correctionReason = reason.trim();
      if (!correctionReason) {
        showToast("冲正原因不能为空");
        return;
      }
      try {
        const result = await api(`/api/stock-movements/${encodeURIComponent(movementId)}/correct`, {
          method: "POST",
          body: JSON.stringify({ correctionReason }),
        });
        state.data = result.state;
        state.movementPage = 1;
        state.movementNewHint = false;
        syncSelections();
        renderAll();
        showToast("冲正成功，库存已更新");
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.querySelectorAll("[data-open-work-order]").forEach((button) => {
    button.addEventListener("click", () => {
      const workOrderId = button.getAttribute("data-open-work-order") || "";
      if (!state.data?.workOrders.some((item) => item.id === workOrderId)) {
        showToast("关联工单不存在或已不可用");
        return;
      }
      state.selectedOrderId = workOrderId;
      state.orderEditorMode = "edit";
      state.workOrderIssueFormOpen = false;
      setView("orders");
      renderOrders();
      renderOrderDetail();
    });
  });

  const materialItemForm = document.getElementById("material-item-form");
  if (materialItemForm) {
    const initialMaterialSnapshot = snapshotOrderForm(materialItemForm);
    state.materialItemEditDirty = false;
    const updateMaterialDirty = () => {
      state.materialItemEditDirty = snapshotOrderForm(materialItemForm) !== initialMaterialSnapshot;
    };
    materialItemForm.addEventListener("input", updateMaterialDirty);
    materialItemForm.addEventListener("change", updateMaterialDirty);
    materialItemForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(materialItemForm);
      const code = String(formData.get("code") || "").trim();
      const isUpdate = getMaterialItems().some((item) => item.code === code);
      const payload = {
        code,
        name: formData.get("name"),
        spec: formData.get("spec"),
        unit: formData.get("unit") || "kg",
        safetyQty: Number(formData.get("safetyQty") || 0),
        defaultLocation: formData.get("defaultLocation"),
      };
      try {
        if (isNumericText(payload.unit)) {
          throw new Error("计量单位请填 kg、张、片等文字；库存数量在下方出入库里调整");
        }
        const result = await api("/api/material-items/save", { method: "POST", body: JSON.stringify(payload) });
        state.data = result.state;
        state.selectedMaterialCode = result.material.code;
        state.selectedMaterialKey = "";
        state.materialEditorMode = "edit";
        state.materialItemEditDirty = false;
        syncSelections();
        renderAll();
        showToast(isUpdate ? "物料档案已更新" : "物料档案已创建");
      } catch (error) {
        showToast(error.message);
      }
    });
  }

  const newMaterialDraftButton = document.getElementById("new-material-draft-btn");
  if (newMaterialDraftButton && materialItemForm) {
    newMaterialDraftButton.addEventListener("click", () => openMaterialDrawer("material"));
  }

  const movementForm = document.getElementById("material-movement-form");
  if (movementForm && selectedBatch) {
    const initialMovementSnapshot = snapshotOrderForm(movementForm);
    state.materialMovementDirty = false;
    const updateMovementDirty = () => {
      state.materialMovementDirty = snapshotOrderForm(movementForm) !== initialMovementSnapshot;
    };
    movementForm.addEventListener("input", updateMovementDirty);
    movementForm.addEventListener("change", updateMovementDirty);
    const refreshFefoPreview = () => {
      const preview = document.getElementById("fefo-plan-preview");
      const reasonField = document.getElementById("fefo-override-field");
      const type = movementForm.elements.type.value;
      const qty = Number(movementForm.elements.qty.value || 0);
      if (type !== "out") {
        preview.innerHTML = '<div class="fefo-advice"><div class="item-title">入库不需要 FEFO 推荐</div><div class="item-note">FEFO 只在生产领料出库时生效。</div></div>';
        reasonField.classList.add("hidden");
        return;
      }
      const advice = buildFefoAdvice(selectedBatch, qty);
      preview.innerHTML = renderFefoAdviceHtml(selectedBatch, qty);
      reasonField.classList.toggle("hidden", !advice.reasonRequired);
    };
    ["type", "qty"].forEach((name) => movementForm.elements[name].addEventListener("input", refreshFefoPreview));
    refreshFefoPreview();
    movementForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(movementForm);
      const advice = buildFefoAdvice(selectedBatch, Number(formData.get("qty") || 0));
      const overrideReason = String(formData.get("overrideReason") || "").trim();
      if (formData.get("type") === "out" && advice.reasonRequired && !overrideReason) {
        showToast("当前批次不符合 FEFO 或已过期，请填写原因");
        return;
      }
      const submitButton = movementForm.querySelector('button[type="submit"]');
      if (submitButton?.disabled) return;
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "正在提交...";
      }
      try {
        const result = await api("/api/stock-movements", {
          method: "POST",
          body: JSON.stringify({
            materialCode: selectedBatch.materialCode,
            batchNo: selectedBatch.batchNo,
            type: formData.get("type"),
            qty: Number(formData.get("qty") || 0),
            location: formData.get("movementLocation"),
            note: formData.get("movementNote"),
            overrideReason,
            source: "admin",
          }),
        });
        state.data = result.state;
        state.selectedMaterialCode = selectedBatch.materialCode;
        state.selectedMaterialKey = materialKey(selectedBatch);
        state.materialMovementDirty = false;
        state.movementPage = 1;
        state.movementNewHint = false;
        syncSelections();
        renderAll();
        const latest = result.state.materialBatches.find((item) => item.materialCode === selectedBatch.materialCode && item.batchNo === selectedBatch.batchNo);
        showToast(`${formData.get("type") === "out" ? "出库" : "入库"}成功，当前库存 ${latest?.stockQty ?? "-"}${selectedUnit}`);
      } catch (error) {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = "提交库存动作";
        }
        showToast(error.message);
      }
    });
  }
}

function renderReporting() {
  renderList(
    "reporting-queue",
    state.data.workOrders,
    (order) => {
      const quality = getWorkOrderQualitySummary(order);
      return `
        <div class="list-item">
          <div class="item-top">
            <div class="item-title">${escapeHtml(order.id)} · ${escapeHtml(order.product)}</div>
            <span class="status ${normalizeStatus(quality.hasFinalShortage ? "延期" : order.status)}">${escapeHtml(order.currentProcess)}</span>
          </div>
          <div class="item-meta">优先级 ${escapeHtml(order.priority)} · 可流转 ${quality.currentTransferableGoodQty} · 成品 ${quality.finishedGoodQty}/${order.plannedQty}</div>
          ${quality.hasFinalShortage ? `<div class="item-note danger-text">最终良品少于计划 ${quality.shortageQty}</div>` : ""}
        </div>
      `;
    }
  );

  document.getElementById("report-table").innerHTML = `
    <div class="table">
      <div class="table-head report-grid">
        <div>工单</div><div>工序</div><div>完成</div><div>良品</div><div>不良</div><div>不良原因 / 备注</div><div>操作人</div>
      </div>
      ${
        state.data.reports
          .map(
            (item) => `
              <div class="table-row report-grid">
                <div>${escapeHtml(item.workOrderId)}</div>
                <div>${escapeHtml(item.processName)}</div>
                <div>${getReportCompletedQty(item)}</div>
                <div>${Number(item.goodQty || 0)}</div>
                <div class="${Number(item.badQty || 0) > 0 ? "danger-text" : ""}">${Number(item.badQty || 0)}</div>
                <div>${escapeHtml([item.badReason, item.note].filter(Boolean).join("；") || "-")}</div>
                <div>${escapeHtml(item.operator || "-")}</div>
              </div>
            `
          )
          .join("") || `<div class="list-item">暂无报工记录。可以打开手机端提交一次。</div>`
      }
    </div>
  `;
}

function renderAlerts() {
  document.getElementById("alerts-list").innerHTML =
    state.data.alerts.map((item) => `<div class="alert-card"><div class="item-title">${escapeHtml(item.title)}</div><div class="item-note">${escapeHtml(item.text)}</div></div>`).join("") ||
    `<div class="empty-state">当前没有预警。</div>`;
}

function renderAll() {
  syncSelections();
  renderDashboard();
  renderSamples();
  renderOrders();
  renderOrderDetail();
  renderMaterials();
  renderReporting();
  renderAlerts();
  disableBrowserSuggestions();
}

function setView(viewKey) {
  state.currentView = viewKey;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.getAttribute("data-view") === viewKey));
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${viewKey}-view`));
  document.getElementById("view-title").textContent = views[viewKey].title;
  document.getElementById("view-subtitle").textContent = views[viewKey].subtitle;
}

function applyAdminDeepLinkFromUrlQuery() {
  if (!state.data) return;
  const url = new URL(window.location.href);
  const sampleId = String(url.searchParams.get("sample") || "").trim();
  const workOrderId = String(url.searchParams.get("workOrder") || url.searchParams.get("order") || "").trim();

  if (sampleId && state.data.samples.some((item) => item.id === sampleId)) {
    state.selectedSampleId = sampleId;
    state.sampleEditorMode = "edit";
    setView("samples");
    return;
  }

  if (workOrderId && state.data.workOrders.some((item) => item.id === workOrderId)) {
    state.selectedOrderId = workOrderId;
    state.orderEditorMode = "edit";
    state.orderDrawerMode = "detail";
    state.orderFocusMode = true;
    setView("orders");
  }
}

function setAutoRefreshStatus(message, tone = "") {
  const status = document.getElementById("auto-refresh-status");
  if (!status) return;
  status.textContent = message;
  status.className = `auto-refresh-status ${tone}`.trim();
}

function hasProtectedEditingState() {
  const activeForm = document.activeElement?.closest?.("form");
  return Boolean(
    hasUnsavedOrderChanges()
    || state.orderDrawerMode === "edit"
    || state.orderEditorMode === "create"
    || state.materialDrawerMode
    || state.materialItemEditDirty
    || state.materialMovementDirty
    || state.workOrderIssueFormOpen
    || state.workOrderIssueDirty
    || activeForm
  );
}

function hasUnsavedInlineChanges() {
  return state.materialItemEditDirty || state.materialMovementDirty || state.workOrderIssueDirty;
}

function confirmDiscardInlineChanges() {
  return !hasUnsavedInlineChanges() || window.confirm("当前页面有未保存修改，确认放弃这些修改吗？");
}

function formatRefreshTime(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function loadState({ source = "manual", force = false } = {}) {
  const isAuto = source === "auto";
  if (state.isAutoRefreshing) return false;
  if (isAuto && !force && hasProtectedEditingState()) {
    state.pendingAutoRefresh = true;
    setAutoRefreshStatus("检测到新数据，完成当前操作后将自动刷新", "pending");
    return false;
  }
  const scrollY = window.scrollY;
  const previousMovementSignature = movementSignature(state.data);
  state.isAutoRefreshing = true;
  try {
    const nextData = await api("/api/state");
    if (isAuto && !force && (Date.now() < state.interactionPauseUntil || hasProtectedEditingState())) {
      state.pendingAutoRefresh = true;
      setAutoRefreshStatus("检测到新数据，完成当前操作后将自动刷新", "pending");
      return false;
    }
    const incomingMovementSignature = movementSignature(nextData);
    if (isAuto && state.movementPage > 1 && previousMovementSignature && incomingMovementSignature !== previousMovementSignature) {
      state.movementNewHint = true;
    }
    state.data = nextData;
    if (!state.deepLinkApplied) {
      applyAdminDeepLinkFromUrlQuery();
      state.deepLinkApplied = true;
    }
    renderAll();
    if (state.materialTraceOpen) {
      void refreshMaterialBatchTrace({ silent: true });
    }
    if (state.orderFocusMode) lockOrderListScroll();
    if (!state.orderScrollLocked) window.requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "auto" }));
    state.lastUpdatedAt = new Date();
    state.autoRefreshFailed = false;
    state.pendingAutoRefresh = false;
    setAutoRefreshStatus(`最后更新：${formatRefreshTime(state.lastUpdatedAt)}`);
    return true;
  } catch (error) {
    state.autoRefreshFailed = true;
    setAutoRefreshStatus("自动更新暂时失败", "error");
    if (!isAuto) throw error;
    console.warn("Auto refresh failed", error);
    return false;
  } finally {
    state.isAutoRefreshing = false;
  }
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) window.clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = null;
}

function runAutoRefresh() {
  if (!token() || !state.currentUser || document.hidden || Date.now() < state.interactionPauseUntil) return;
  loadState({ source: "auto" });
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.autoRefreshTimer = window.setInterval(runAutoRefresh, AUTO_REFRESH_INTERVAL_MS);
}

async function loadSession() {
  const result = await api("/api/me");
  state.currentUser = result.user;
  renderUser();
  if (!ensureManagerSession(result.user)) return;
  await loadState();
  startAutoRefresh();
}

function logout() {
  if (!confirmDiscardOrderChanges() || !confirmDiscardMaterialDrawerChanges() || !confirmDiscardInlineChanges()) return;
  unlockOrderListScroll();
  stopAutoRefresh();
  clearToken();
  state.currentUser = null;
  state.data = null;
  state.selectedSampleId = "";
  state.selectedOrderId = "";
  state.sampleEditorMode = "edit";
  state.orderEditorMode = "edit";
  state.orderFocusMode = false;
  state.orderDrawerMode = "detail";
  state.orderFormDirty = false;
  state.orderFormInitialSnapshot = "";
  state.orderSaving = false;
  state.orderListScrollY = 0;
  state.activityPage = 1;
  state.orderPage = 1;
  state.batchPage = 1;
  state.movementPage = 1;
  state.materialDrawerMode = "";
  state.materialDrawerDirty = false;
  state.materialTraceRequestVersion += 1;
  state.materialTraceOpen = false;
  state.materialTraceBatchId = "";
  state.materialTraceData = null;
  state.materialTraceLoading = false;
  state.materialTraceError = "";
  state.materialTraceExpandedWorkOrders = {};
  state.materialTraceView = "trace";
  state.materialTraceReturnOrderId = "";
  state.materialTraceScrollTop = 0;
  state.materialMovementDirty = false;
  state.materialItemEditDirty = false;
  state.workOrderIssueDirty = false;
  state.deepLinkApplied = false;
  document.getElementById("login-error").textContent = "";
  renderUser();
  setLoggedIn(false);
}

function enterNewOrderMode() {
  if (!confirmDiscardOrderChanges()) return;
  state.orderBeforeCreateId = state.selectedOrderId;
  state.orderEditorMode = "create";
  state.selectedOrderId = "";
  state.orderFocusMode = true;
  state.orderDrawerMode = "edit";
  state.orderFormDirty = false;
  state.orderFormInitialSnapshot = "";
  setView("orders");
  if (state.data) {
    renderOrders();
    renderOrderDetail();
    focusOrderDetail();
  }
}

function bindEvents() {
  document.addEventListener("pointerdown", () => {
    state.interactionPauseUntil = Date.now() + 1500;
  }, { passive: true });
  document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => {
    const nextView = item.getAttribute("data-view");
    if (nextView !== state.currentView && !confirmDiscardInlineChanges()) return;
    if (state.orderFocusMode && nextView !== "orders" && !requestCloseOrderDrawer()) return;
    if (state.materialDrawerMode && nextView !== "materials" && !closeMaterialDrawer()) return;
    setView(nextView);
  }));
  document.getElementById("refresh-btn").addEventListener("click", () => {
    if (!confirmDiscardOrderChanges() || !confirmDiscardMaterialDrawerChanges() || !confirmDiscardInlineChanges()) return;
    loadState({ source: "manual", force: true }).catch((error) => showToast(error.message));
  });
  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("new-order-btn").addEventListener("click", enterNewOrderMode);
  document.getElementById("edit-order-btn").addEventListener("click", startOrderEditing);
  document.getElementById("cancel-order-edit-btn").addEventListener("click", cancelOrderEditing);
  document.getElementById("cancel-order-footer-btn").addEventListener("click", cancelOrderEditing);
  document.getElementById("close-order-detail-btn").addEventListener("click", requestCloseOrderDrawer);
  document.getElementById("order-detail-backdrop").addEventListener("click", requestCloseOrderDrawer);
  document.getElementById("close-material-drawer-btn").addEventListener("click", () => closeMaterialDrawer());
  document.getElementById("cancel-material-drawer-btn").addEventListener("click", () => closeMaterialDrawer());
  document.getElementById("material-drawer-backdrop").addEventListener("click", () => closeMaterialDrawer());
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (state.materialDrawerMode) closeMaterialDrawer();
    else if (state.orderFocusMode) requestCloseOrderDrawer();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedOrderChanges() && !hasUnsavedMaterialDrawerChanges() && !hasUnsavedInlineChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      document.getElementById("login-error").textContent = "";
      const result = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("username").value.trim(),
          password: document.getElementById("password").value,
        }),
      });
      localStorage.setItem(tokenKey, result.token);
      state.currentUser = result.user;
      if (!ensureManagerSession(result.user, result.token)) return;
      setLoggedIn(true);
      renderUser();
      await loadState();
      startAutoRefresh();
    } catch (error) {
      document.getElementById("login-error").textContent = error.message;
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) runAutoRefresh();
  });
  window.addEventListener("focus", runAutoRefresh);
}

bindEvents();
renderUser();
disableBrowserSuggestions();

if (token()) {
  setLoggedIn(true);
  loadSession().catch(() => logout());
}


