const tokenKey = "insole_mes_alpha_token_mobile";
const adminTokenKey = "insole_mes_alpha_token_admin";

import QrScanner from "/vendor/qr-scanner/qr-scanner.min.js";
import { parseBatchCode, parseWorkOrderCode } from "./mobile-code-parser.js";
import {
  getProcessInputContext as calculateProcessInputContext,
  getProcessReportedQty as calculateProcessReportedQty,
  getRemainingReportableQty as calculateRemainingReportableQty,
  getWorkOrderFlowSummary as calculateWorkOrderFlowSummary,
  validateReportPayload,
} from "./production-metrics.js";

const mobileState = {
  selectedOrderId: "",
  currentUser: null,
  data: null,
  scanValue: "",
  workOrderScanValue: "",
  reportSubmitting: false,
  stockSubmitting: false,
  materialIssueSubmitting: false,
  materialIssueSubmitUnknown: false,
};

const materialIssueState = {
  step: "workOrder",
  workOrderId: "",
  workOrderScanValue: "",
  batchScanValue: "",
  materialBatchId: "",
  materialCode: "",
  batchNo: "",
  location: "",
  qty: "",
  overrideReason: "",
  note: "",
  result: null,
};

const scanState = {
  scanner: null,
  active: false,
  starting: false,
  target: "",
  requestId: 0,
  cleanupPromise: Promise.resolve(),
};

const sheetState = {
  locked: false,
  scrollY: 0,
};

const roleLabels = {
  manager: "管理端",
  worker: "现场端",
  warehouse: "现场端",
};

function token() {
  return localStorage.getItem(tokenKey);
}

function clearToken() {
  localStorage.removeItem(tokenKey);
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
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.message || "请求失败");
    error.status = response.status;
    error.code = payload.error || "";
    throw error;
  }
  return payload;
}

function setLoggedIn(value) {
  document.getElementById("login-screen").classList.toggle("hidden", value);
  document.getElementById("mobile-app").classList.toggle("hidden", !value);
}

function renderUser() {
  const user = mobileState.currentUser;
  document.getElementById("current-user").textContent = user ? `${user.name} | ${roleLabels[user.role] || user.role}` : "未登录";
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 1800);
}

function currentOrder() {
  return mobileState.data?.workOrders?.find((order) => order.id === mobileState.selectedOrderId) || null;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function getProcessReportedQty(orderId, processName) {
  return calculateProcessReportedQty(orderId, processName, mobileState.data?.reports || []);
}

function getRemainingReportableQty(order, processName) {
  return calculateRemainingReportableQty(order, processName, mobileState.data?.reports || []);
}

function getProcessInputContext(order, processName) {
  return calculateProcessInputContext(order, processName, mobileState.data?.reports || []);
}

function getWorkOrderFlowSummary(order) {
  return calculateWorkOrderFlowSummary(order, mobileState.data?.reports || []);
}

function syncDerivedGoodQty() {
  const completedQty = Number(document.getElementById("completed-qty").value || 0);
  const badQty = Number(document.getElementById("bad-qty").value || 0);
  document.getElementById("good-qty").value = String(Math.max(0, completedQty - badQty));
}

function daysUntil(dateValue) {
  if (!dateValue) return Number.POSITIVE_INFINITY;
  const now = new Date();
  const target = new Date(dateValue);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function todayKey(dateValue) {
  return new Date(dateValue).toISOString().slice(0, 10);
}

function buildBatchCode(material) {
  return ["MAT", material.code, material.batchNo, material.location || ""].join("|");
}

function buildWorkOrderCode(order) {
  return ["WO", order.id, order.currentProcess || ""].join("|");
}

function findMaterial(materialCode, batchNo) {
  return (mobileState.data?.materials || []).find((item) => item.code === materialCode && item.batchNo === batchNo) || null;
}

function findWorkOrder(workOrderId) {
  return (mobileState.data?.workOrders || []).find((item) => item.id === workOrderId) || null;
}

function selectValueForMaterial(material) {
  return `${material.code}|${material.batchNo}|${material.location || ""}`;
}

function getBatchStatus(material) {
  if (material?.batchStatus) return material.batchStatus;
  if (Number(material?.stockQty || 0) <= 0) return "已用完";
  const expiryDate = String(material?.expiryDate || "").slice(0, 10);
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

function buildLocalFefoPlan(materialCode, qty, includeExpired = false) {
  const candidates = (mobileState.data?.materials || [])
    .filter((item) => item.code === materialCode && Number(item.stockQty || 0) > 0)
    .map((item) => ({ ...item, status: getBatchStatus(item) }))
    .filter((item) => includeExpired || item.status !== "已过期")
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
  for (const item of candidates) {
    if (remainingQty <= 0) break;
    const issueQty = Math.min(Number(item.stockQty || 0), remainingQty);
    plan.push({ ...item, qty: issueQty });
    remainingQty -= issueQty;
  }
  return { plan, recommendedBatch: plan[0] || null, remainingQty, unit: candidates[0]?.unit || "" };
}

function getSelectedStockMaterial() {
  const batchValue = document.getElementById("stock-batch")?.value || "";
  const [materialCode, batchNo] = batchValue.split("|");
  return findMaterial(materialCode, batchNo);
}

function buildFefoAdvice(material, qty) {
  if (!material) {
    return { title: "未选择批次", text: "先扫码或选择一个批次。", reasonRequired: false, tone: "" };
  }
  const status = getBatchStatus(material);
  const plan = buildLocalFefoPlan(material.code, qty);
  const planText = plan.plan.length ? plan.plan.map((item) => `${item.batchNo} ${item.qty}${item.unit}`).join(" + ") : "暂无可用未过期批次";

  if (status === "已过期") {
    return { title: "当前批次已过期", text: `必须填写原因后才能强制出库。推荐拆分：${planText}`, reasonRequired: true, tone: "warn" };
  }
  if (!plan.recommendedBatch) {
    return { title: "没有可推荐批次", text: "当前物料没有可用的未过期库存。", reasonRequired: false, tone: "warn" };
  }
  if (plan.recommendedBatch.batchNo !== material.batchNo) {
    return { title: `FEFO 建议先用 ${plan.recommendedBatch.batchNo}`, text: `如仍要用当前批次，请填写原因。推荐拆分：${planText}`, reasonRequired: true, tone: "warn" };
  }
  return { title: "当前批次符合 FEFO", text: `推荐拆分：${planText}${plan.remainingQty > 0 ? `，仍缺 ${plan.remainingQty}${plan.unit}` : ""}`, reasonRequired: false, tone: "running" };
}

function updateStockFefoPreview() {
  const preview = document.getElementById("stock-fefo-preview");
  const reasonWrap = document.getElementById("stock-override-wrap");
  if (!preview || !reasonWrap) return;
  const type = document.getElementById("stock-type")?.value || "in";
  if (type !== "out") {
    preview.textContent = "入库不需要 FEFO 推荐；出库时会自动提示最早过期批次。";
    reasonWrap.classList.add("hidden");
    return;
  }
  const material = getSelectedStockMaterial();
  const qty = Number(document.getElementById("stock-qty")?.value || 0);
  const advice = buildFefoAdvice(material, qty);
  preview.innerHTML = `<strong>${escapeHtml(advice.title)}</strong><br>${escapeHtml(advice.text)}`;
  reasonWrap.classList.toggle("hidden", !advice.reasonRequired);
}

function getRoleConfig(role) {
  const canIssueMaterial = role === "manager" || role === "worker";
  return {
    eyebrow: "现场端",
    title: "现场作业",
    loginTitle: role === "warehouse" ? "现场端登录" : "现场端登录",
    banner: "现场端适合小工厂同一个人兼做接单、报工、原材料入库、成品暂存和出库；所有提交都会回流到管理端。",
    tasksTitle: "当前工单",
    tasksMeta: "按交期排序",
    reportTitle: "工序报工",
    primaryAction: { text: "扫工单码", action: "scan-work" },
    secondaryAction: { text: "扫码入库", action: "stock-in" },
    tertiaryAction: { text: "扫码出库", action: "stock-out" },
    materialIssueAction: { text: "工单领料", action: "material-issue", hidden: !canIssueMaterial },
    showTasks: true,
    showReport: true,
    showStock: true,
    nav: [
      { id: "nav-one", label: "概览", target: "summary-strip", hidden: false },
      { id: "nav-two", label: "报工", target: "report-section", hidden: false },
      { id: "nav-three", label: "出入库", target: "stock-section", hidden: false },
    ],
  };
}

function applyRoleMode() {
  const user = mobileState.currentUser;
  if (!user) return;

  const config = getRoleConfig(user.role);
  document.getElementById("login-title").textContent = config.loginTitle;
  document.getElementById("app-eyebrow").textContent = config.eyebrow;
  document.getElementById("app-title").textContent = config.title;
  document.getElementById("role-banner").textContent = config.banner;
  document.getElementById("tasks-title").textContent = config.tasksTitle;
  document.getElementById("tasks-meta").textContent = config.tasksMeta;
  document.getElementById("report-title").textContent = config.reportTitle;
  document.getElementById("admin-link").classList.toggle("hidden", user.role !== "manager");

  document.getElementById("action-primary").textContent = config.primaryAction.text;
  document.getElementById("action-primary").setAttribute("data-action", config.primaryAction.action);
  document.getElementById("action-secondary").textContent = config.secondaryAction.text;
  document.getElementById("action-secondary").setAttribute("data-action", config.secondaryAction.action);
  document.getElementById("action-tertiary").textContent = config.tertiaryAction.text;
  document.getElementById("action-tertiary").setAttribute("data-action", config.tertiaryAction.action);
  document.getElementById("action-material-issue").textContent = config.materialIssueAction.text;
  document.getElementById("action-material-issue").setAttribute("data-action", config.materialIssueAction.action);
  document.getElementById("action-material-issue").classList.toggle("hidden", config.materialIssueAction.hidden);

  document.getElementById("tasks-section").classList.toggle("hidden", !config.showTasks);
  document.getElementById("report-section").classList.toggle("hidden", !config.showReport);
  document.getElementById("stock-section").classList.toggle("hidden", !config.showStock);

  config.nav.forEach((item) => {
    const button = document.getElementById(item.id);
    button.textContent = item.label;
    button.setAttribute("data-scroll", item.target);
    button.classList.toggle("hidden", item.hidden);
  });
}

function renderSummary() {
  const user = mobileState.currentUser;
  const root = document.getElementById("summary-strip");
  if (!user || !mobileState.data) {
    root.innerHTML = "";
    return;
  }

  const workOrders = mobileState.data.workOrders || [];
  const pending = workOrders.filter((order) => order.status !== "已完成").length;
  const materials = mobileState.data.materials || [];
  const lowStock = materials.filter((item) => Number(item.stockQty) < Number(item.safetyQty)).length;
  const todayMovements = (mobileState.data.stockMovements || []).filter((item) => todayKey(item.createdAt) === todayKey(new Date())).length;
  root.innerHTML = `
    <div><span class="summary-value">${pending}</span><span class="summary-label">待办工单</span></div>
    <div><span class="summary-value">${lowStock}</span><span class="summary-label">低库存批次</span></div>
    <div><span class="summary-value">${todayMovements}</span><span class="summary-label">今日出入库</span></div>
  `;
}

function renderTasks() {
  const root = document.getElementById("task-list");
  const workOrders = (mobileState.data?.workOrders || []).filter((order) => order.status !== "已完成");
  if (!workOrders.length) {
    root.innerHTML = '<div class="empty-state">当前没有待办工单。</div>';
    return;
  }

  if (!mobileState.selectedOrderId || !workOrders.some((order) => order.id === mobileState.selectedOrderId)) {
    mobileState.selectedOrderId = workOrders[0].id;
  }

  root.innerHTML = workOrders
    .map((order) => {
      const flow = getWorkOrderFlowSummary(order);
      const progress = order.plannedQty
        ? Math.round((Number(flow.currentTransferableGoodQty || 0) / Number(order.plannedQty)) * 100)
        : 0;
      const isSelected = order.id === mobileState.selectedOrderId;
      const pendingClass = order.status === "待领料" || order.status === "待开始" ? "pending" : "";
      return `
        <button class="task-card ${isSelected ? "active" : ""}" data-order-id="${order.id}">
          <div class="task-top">
            <div>
              <div class="task-title" title="${escapeHtml(order.product || "未填写产品")}">${escapeHtml(order.product || "未填写产品")}</div>
              <div class="task-code">${escapeHtml(order.id || "未编号")}</div>
            </div>
            <span class="status ${pendingClass}">${escapeHtml(order.status || "未设置状态")}</span>
          </div>
          <div class="task-meta">
            <span>当前：${escapeHtml(order.currentProcess || "未配置工序")}</span>
            <span>交期：${escapeHtml(order.dueAt || "未设置")}</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, progress))}%"></div></div>
          <div class="task-footer">
            <span>计划 ${order.plannedQty} 双</span>
            <span>可流转 ${flow.currentTransferableGoodQty} · 成品 ${flow.finishedGoodQty}</span>
          </div>
        </button>
      `;
    })
    .join("");

  root.querySelectorAll("[data-order-id]").forEach((card) => {
    card.addEventListener("click", () => {
      mobileState.selectedOrderId = card.getAttribute("data-order-id");
      const selectedOrder = workOrders.find((order) => order.id === mobileState.selectedOrderId);
      mobileState.workOrderScanValue = selectedOrder ? buildWorkOrderCode(selectedOrder) : "";
      renderTasks();
      renderReportForm();
    });
  });
}

function renderMobileReportForm() {
  const order = currentOrder();
  const stageSelect = document.getElementById("report-stage");
  const route = Array.isArray(order?.route) ? order.route.filter((stage) => stage?.name) : [];
  const fallbackStages = order?.currentProcess ? [{ name: order.currentProcess, status: "进行中" }] : [];
  const stages = route.length ? route : fallbackStages;
  const previousStage = stageSelect.value;
  const disabled = !order || !stages.length;

  document.getElementById("selected-order-label").textContent = order ? order.id : "暂无工单";
  stageSelect.innerHTML = stages.length
    ? stages.map((stage) => `<option value="${escapeHtml(stage.name)}">${escapeHtml(stage.name)}</option>`).join("")
    : '<option value="">暂无可报工工单</option>';
  if (stages.some((stage) => stage.name === previousStage)) {
    stageSelect.value = previousStage;
  } else if (order?.currentProcess && stages.some((stage) => stage.name === order.currentProcess)) {
    stageSelect.value = order.currentProcess;
  }

  const workOrderInput = document.getElementById("workorder-scan-input");
  const workOrderPreview = document.getElementById("workorder-scan-preview");
  if (workOrderInput) {
    const defaultCode = order ? buildWorkOrderCode(order) : "";
    if (!mobileState.workOrderScanValue) {
      mobileState.workOrderScanValue = defaultCode;
    }
    workOrderInput.value = mobileState.workOrderScanValue || defaultCode;
  }
  if (workOrderPreview) {
    workOrderPreview.textContent = order ? `当前工单：${order.id} / ${order.product} / 当前工序 ${order.currentProcess}` : "未识别工单";
  }

  const selectedStage = stageSelect.value;
  const reportedQty = order ? getProcessReportedQty(order.id, selectedStage) : 0;
  const remainingQty = order ? getRemainingReportableQty(order, selectedStage) : 0;
  const inputContext = order ? getProcessInputContext(order, selectedStage) : null;
  const stageIndex = stages.findIndex((stage) => stage.name === selectedStage);
  const selectedStageData = stages[stageIndex] || null;
  const inputDescription = !inputContext
    ? ""
    : inputContext.isFirst
      ? `首道工序，输入上限为计划数 ${inputContext.inputLimit}`
      : inputContext.source === "reported-good"
        ? `上道 ${inputContext.previousProcessName} 良品 ${inputContext.previousGoodQty}，本工序最多可报 ${inputContext.inputLimit}`
        : inputContext.source === "legacy-route"
          ? `上道 ${inputContext.previousProcessName} 缺少历史报工，暂按计划数 ${inputContext.inputLimit} 兼容`
          : `上道 ${inputContext.previousProcessName || "工序"} 尚无可流转良品，当前不能报工`;
  const summary = document.getElementById("report-order-summary");
  summary.innerHTML = order
    ? `
      <div class="report-order-head">
        <div>
          <strong title="${escapeHtml(order.product || "未填写产品")}">${escapeHtml(order.product || "未填写产品")}</strong>
          <span>${escapeHtml(order.id || "未编号")}</span>
        </div>
        <span class="mobile-status">${escapeHtml(order.status || "未设置状态")}</span>
      </div>
      <div class="report-summary-grid">
        <div><span>计划</span><strong>${Number(order.plannedQty || 0)}</strong></div>
        <div><span>输入上限</span><strong>${Number(inputContext?.inputLimit || 0)}</strong></div>
        <div><span>本工序已报</span><strong>${reportedQty}</strong></div>
        <div><span>剩余</span><strong>${remainingQty}</strong></div>
      </div>
      <div class="process-description">
        第 ${stageIndex >= 0 ? stageIndex + 1 : "-"} / ${stages.length || "-"} 道 ·
        ${escapeHtml(selectedStage || "未配置工序")} ·
        ${escapeHtml(selectedStageData?.status || "状态未知")}
      </div>
      <div class="process-input-note">${escapeHtml(inputDescription)}</div>
    `
    : '<div class="empty-state">请先扫码或选择一张工单。</div>';

  const completedInput = document.getElementById("completed-qty");
  completedInput.max = String(remainingQty);
  completedInput.setAttribute("aria-describedby", "report-order-summary");

  ["report-stage", "completed-qty", "good-qty", "bad-qty", "bad-reason", "report-note", "report-submit-btn"].forEach((id) => {
    document.getElementById(id).disabled = disabled;
  });
  document.getElementById("report-submit-btn").disabled = disabled || remainingQty <= 0 || mobileState.reportSubmitting;
  document.getElementById("report-submit-btn").textContent = mobileState.reportSubmitting ? "正在提交…" : remainingQty <= 0 && order ? "当前工序已报完" : "提交报工";
  const errorRoot = document.getElementById("report-form-error");
  errorRoot.classList.add("hidden");
  errorRoot.textContent = "";
}

const renderReportForm = renderMobileReportForm;

function updateStockMode() {
  const type = document.getElementById("stock-type")?.value || "in";
  const hasBatch = Boolean(document.getElementById("stock-batch")?.value);
  document.getElementById("stock-qty-label").textContent = type === "out" ? "出库数量" : "入库数量";
  document.getElementById("stock-submit-btn").textContent = mobileState.stockSubmitting ? "正在提交..." : type === "out" ? "提交出库" : "提交入库";
  document.getElementById("stock-submit-btn").disabled = mobileState.stockSubmitting || !hasBatch;
  document.getElementById("stock-title").textContent = type === "out" ? "扫码出库" : "扫码入库";
  updateStockFefoPreview();
}

function renderStockForm() {
  const select = document.getElementById("stock-batch");
  const materials = mobileState.data?.materials || [];
  const previousValue = select.value;
  const disabled = !materials.length;

  select.innerHTML = materials.length
    ? materials
        .map((item) => {
          const value = selectValueForMaterial(item);
          const stockText = `${item.stockQty}${item.unit}`;
          return `<option value="${value}">${item.batchNo} | ${item.name} | ${item.location} | 库存 ${stockText}</option>`;
        })
        .join("")
    : '<option value="">暂无可操作批次</option>';

  if (materials.some((item) => selectValueForMaterial(item) === previousValue)) {
    select.value = previousValue;
  }

  if (!select.value && materials[0]) {
    select.value = selectValueForMaterial(materials[0]);
  }

  const selectedMaterial = materials.find((item) => selectValueForMaterial(item) === select.value) || materials[0] || null;
  if (selectedMaterial) {
    document.getElementById("stock-location").value = selectedMaterial.location || "";
    if (!mobileState.scanValue) {
      mobileState.scanValue = buildBatchCode(selectedMaterial);
      document.getElementById("scan-input").value = mobileState.scanValue;
      document.getElementById("scan-preview").textContent = `当前批次码：${mobileState.scanValue}`;
    }
  }

  ["stock-type", "stock-batch", "stock-qty", "stock-location", "stock-note", "stock-override-reason", "stock-submit-btn", "scan-input", "scan-apply-btn"].forEach((id) => {
    document.getElementById(id).disabled = disabled;
  });

  updateStockMode();
}

function applyBatchCode(rawValue, announce = true) {
  const parsed = parseBatchCode(rawValue);
  if (!parsed) {
    document.getElementById("scan-preview").textContent = "未识别批次，请检查二维码内容格式";
    if (announce) showToast("批次码格式不对");
    return false;
  }

  const material = findMaterial(parsed.materialCode, parsed.batchNo);
  if (!material) {
    document.getElementById("scan-preview").textContent = `未找到批次：${parsed.batchNo}`;
    if (announce) showToast("系统里还没有这个批次");
    return false;
  }

  mobileState.scanValue = buildBatchCode({ ...material, location: parsed.location || material.location });
  document.getElementById("scan-input").value = mobileState.scanValue;
  document.getElementById("scan-preview").textContent = `已识别：${material.name} / ${material.batchNo} / ${parsed.location || material.location}`;
  document.getElementById("stock-batch").value = selectValueForMaterial(material);
  document.getElementById("stock-location").value = parsed.location || material.location || "";
  updateStockFefoPreview();
  if (announce) showToast("批次已带入表单");
  return true;
}

function setScanStatus(message) {
  document.getElementById("scan-status").textContent = message;
}

function setWorkOrderScanStatus(message) {
  document.getElementById("workorder-scan-status").textContent = message;
}

function applyWorkOrderCode(rawValue, announce = true) {
  const parsed = parseWorkOrderCode(rawValue);
  if (!parsed) {
    document.getElementById("workorder-scan-preview").textContent = "未识别工单，请检查二维码内容格式";
    if (announce) showToast("工单码格式不对");
    return false;
  }

  const order = findWorkOrder(parsed.workOrderId);
  if (!order) {
    document.getElementById("workorder-scan-preview").textContent = `未找到工单：${parsed.workOrderId}`;
    if (announce) showToast("系统里还没有这个工单");
    return false;
  }

  mobileState.selectedOrderId = order.id;
  mobileState.workOrderScanValue = buildWorkOrderCode({ ...order, currentProcess: parsed.processName || order.currentProcess });
  document.getElementById("workorder-scan-input").value = mobileState.workOrderScanValue;
  renderTasks();
  renderReportForm();

  const stageSelect = document.getElementById("report-stage");
  if (parsed.processName && Array.from(stageSelect.options).some((option) => option.value === parsed.processName)) {
    stageSelect.value = parsed.processName;
  }

  setWorkOrderScanStatus("已识别工单，可直接填写良品 / 不良并提交报工。");
  document.getElementById("workorder-scan-preview").textContent = `已带入：${order.id} / ${order.product} / 当前工序 ${parsed.processName || order.currentProcess}`;
  openWorkflowSheet("report");
  if (announce) showToast("工单已带入报工页");
  return true;
}

const materialIssueAllowedStatuses = new Set(["待领料", "待开始", "生产中"]);
const materialIssueSteps = ["workOrder", "batch", "input", "confirm"];

function formatQuantity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return String(Number(numeric.toFixed(12)));
}

function selectedMaterialIssueOrder() {
  return findWorkOrder(materialIssueState.workOrderId);
}

function selectedMaterialIssueBatch() {
  return findMaterial(materialIssueState.materialCode, materialIssueState.batchNo);
}

function issueCardGrid(items) {
  return `<div class="issue-card-grid">${items
    .map(
      ([label, value]) => `
        <div class="issue-card-item">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value ?? "-")}</strong>
        </div>
      `
    )
    .join("")}</div>`;
}

function setMaterialIssueError(message = "") {
  const root = document.getElementById("material-issue-error");
  root.textContent = message;
  root.classList.toggle("hidden", !message);
}

function setMaterialIssueStep(step) {
  if (mobileState.materialIssueSubmitting) return;
  void stopCameraScan({ keepStatus: true });
  materialIssueState.step = step;
  renderMaterialIssue();
  window.setTimeout(() => {
    document.querySelector("#material-issue-section .workflow-sheet-body")?.scrollTo({ top: 0, behavior: "auto" });
  }, 20);
}

function resetMaterialIssue({ keepOrder = false } = {}) {
  const orderId = keepOrder ? materialIssueState.workOrderId : "";
  const workOrderScanValue = keepOrder ? materialIssueState.workOrderScanValue : "";
  Object.assign(materialIssueState, {
    step: keepOrder ? "batch" : "workOrder",
    workOrderId: orderId,
    workOrderScanValue,
    batchScanValue: "",
    materialBatchId: "",
    materialCode: "",
    batchNo: "",
    location: "",
    qty: "",
    overrideReason: "",
    note: "",
    result: null,
  });
  mobileState.materialIssueSubmitting = false;
  mobileState.materialIssueSubmitUnknown = false;
  const fieldValues = {
    "issue-workorder-input": workOrderScanValue,
    "issue-batch-input": "",
    "issue-qty": "",
    "issue-override-reason": "",
    "issue-note": "",
  };
  Object.entries(fieldValues).forEach(([id, value]) => {
    const field = document.getElementById(id);
    if (field) field.value = value;
  });
  setMaterialIssueError("");
  renderMaterialIssue();
}

function applyMaterialIssueWorkOrder(rawValue) {
  const parsed = parseWorkOrderCode(rawValue);
  if (!parsed) {
    setMaterialIssueError("未识别到本系统工单二维码。");
    return false;
  }
  const order = findWorkOrder(parsed.workOrderId);
  if (!order) {
    setMaterialIssueError("工单不存在。");
    return false;
  }
  if (!materialIssueAllowedStatuses.has(String(order.status || ""))) {
    setMaterialIssueError(`当前工单状态不允许领料：${order.status || "未知状态"}`);
    return false;
  }
  materialIssueState.workOrderId = order.id;
  materialIssueState.workOrderScanValue = buildWorkOrderCode({
    ...order,
    currentProcess: parsed.processName || order.currentProcess,
  });
  document.getElementById("issue-workorder-input").value = materialIssueState.workOrderScanValue;
  setMaterialIssueError("");
  renderMaterialIssue();
  return true;
}

function applyMaterialIssueBatch(rawValue) {
  const parsed = parseBatchCode(rawValue);
  if (!parsed) {
    setMaterialIssueError("未识别到本系统物料批次二维码。");
    return false;
  }
  const batch = findMaterial(parsed.materialCode, parsed.batchNo);
  if (!batch) {
    setMaterialIssueError("物料批次不存在。");
    return false;
  }
  if (Number(batch.stockQty || 0) <= 0) {
    setMaterialIssueError("当前批次已用完。");
    return false;
  }
  materialIssueState.batchScanValue = buildBatchCode({ ...batch, location: parsed.location || batch.location });
  materialIssueState.materialBatchId = batch.materialBatchId || "";
  materialIssueState.materialCode = batch.code;
  materialIssueState.batchNo = batch.batchNo;
  materialIssueState.location = parsed.location || batch.location || "";
  document.getElementById("issue-batch-input").value = materialIssueState.batchScanValue;
  setMaterialIssueError("");
  renderMaterialIssue();
  return true;
}

function validateMaterialIssueInput() {
  const batch = selectedMaterialIssueBatch();
  const qtyText = String(document.getElementById("issue-qty").value || "").trim();
  const qty = Number(qtyText);
  if (!qtyText || !Number.isFinite(qty) || qty <= 0) {
    return "领料数量必须是大于 0 的有效数字。";
  }
  if (!batch || Number(batch.stockQty || 0) <= 0) return "当前批次已用完。";
  if (qty > Number(batch.stockQty || 0)) {
    return `库存不足，当前可用库存为 ${formatQuantity(batch.stockQty)} ${batch.unit || ""}。`;
  }
  const advice = buildFefoAdvice(batch, qty);
  const reason = document.getElementById("issue-override-reason").value.trim();
  if (advice.reasonRequired && !reason) {
    return getBatchStatus(batch) === "已过期"
      ? "当前批次已过期，领取前必须填写原因。"
      : "当前批次不是 FEFO 推荐批次，请填写原因。";
  }
  materialIssueState.qty = qty;
  materialIssueState.overrideReason = reason;
  materialIssueState.note = document.getElementById("issue-note").value.trim();
  return "";
}

function renderMaterialIssue() {
  const order = selectedMaterialIssueOrder();
  const batch = selectedMaterialIssueBatch();
  const stepIndex = materialIssueSteps.indexOf(materialIssueState.step);
  const isResult = materialIssueState.step === "result";
  document.getElementById("material-issue-step-label").textContent = isResult
    ? "领料结果"
    : `步骤 ${Math.max(0, stepIndex) + 1} / 4 · ${["确认工单", "确认批次", "填写数量", "最终确认"][Math.max(0, stepIndex)]}`;

  const stepIds = {
    workOrder: "material-issue-workorder-step",
    batch: "material-issue-batch-step",
    input: "material-issue-input-step",
    confirm: "material-issue-confirm-step",
    result: "material-issue-result-step",
  };
  Object.entries(stepIds).forEach(([step, id]) => {
    document.getElementById(id).classList.toggle("hidden", materialIssueState.step !== step);
  });

  const orderFlow = order ? getWorkOrderFlowSummary(order) : null;
  const orderItems = order
    ? [
        ["工单号", order.id],
        ["产品", order.product || "-"],
        ["状态", order.status || "-"],
        ["当前工序", order.currentProcess || "-"],
        ["计划数量", formatQuantity(order.plannedQty)],
        ["已报工数量", formatQuantity(orderFlow?.currentTransferableGoodQty || order.doneQty || 0)],
        ["是否加急", order.priority === "高" ? "是" : "否"],
        ["交期", order.dueAt || "-"],
      ]
    : [];
  const workOrderSummary = document.getElementById("issue-workorder-summary");
  workOrderSummary.classList.toggle("hidden", !order);
  workOrderSummary.innerHTML = order
    ? `${issueCardGrid(orderItems)}${order.status === "待开始" ? '<div class="issue-notice">工单尚未开始，请确认是否提前领料。</div>' : ""}`
    : "";
  document.getElementById("issue-selected-order").innerHTML = order
    ? `<strong>${escapeHtml(order.id)}</strong><span>${escapeHtml(order.product || "")} · ${escapeHtml(order.status || "")}</span>`
    : "";

  const batchItems = batch
    ? [
        ["物料", batch.name || batch.code],
        ["物料编号", batch.code],
        ["批次号", batch.batchNo],
        ["当前库存", `${formatQuantity(batch.stockQty)} ${batch.unit || ""}`],
        ["库位", materialIssueState.location || batch.location || "-"],
        ["来料日期", String(batch.receivedDate || "-").slice(0, 10)],
        ["到期日期", String(batch.expiryDate || "-").slice(0, 10)],
        ["批次状态", getBatchStatus(batch)],
      ]
    : [];
  const batchSummary = document.getElementById("issue-batch-summary");
  batchSummary.classList.toggle("hidden", !batch);
  batchSummary.innerHTML = batch ? issueCardGrid(batchItems) : "";
  document.getElementById("issue-input-summary").innerHTML = batch
    ? `<strong>${escapeHtml(batch.name || batch.code)} · ${escapeHtml(batch.batchNo)}</strong><span>库存 ${formatQuantity(batch.stockQty)} ${escapeHtml(batch.unit || "")} · ${escapeHtml(materialIssueState.location || batch.location || "-")}</span>`
    : "";
  document.getElementById("issue-unit").textContent = batch?.unit || "";

  if (batch) {
    const qty = Number(document.getElementById("issue-qty")?.value || materialIssueState.qty || 0);
    const advice = buildFefoAdvice(batch, qty);
    const plan = buildLocalFefoPlan(batch.code, qty);
    const recommended = plan.recommendedBatch;
    const fefoPanel = document.getElementById("issue-fefo-panel");
    fefoPanel.className = `fefo-panel ${advice.reasonRequired ? (getBatchStatus(batch) === "已过期" ? "danger" : "") : "success"}`.trim();
    fefoPanel.innerHTML = `
      <strong>${escapeHtml(advice.title)}</strong><br>
      ${escapeHtml(advice.text)}
      ${
        recommended
          ? `<br>推荐批次：<strong>${escapeHtml(recommended.batchNo)}</strong> · 库存 ${formatQuantity(recommended.stockQty)} ${escapeHtml(recommended.unit || "")} · 到期 ${escapeHtml(String(recommended.expiryDate || "-").slice(0, 10))}`
          : ""
      }
    `;
    document.getElementById("issue-override-wrap").classList.toggle("hidden", !advice.reasonRequired);
  }

  if (order && batch && materialIssueState.qty) {
    const advice = buildFefoAdvice(batch, materialIssueState.qty);
    document.getElementById("issue-confirm-summary").innerHTML = issueCardGrid([
      ["工单", order.id],
      ["产品", order.product || "-"],
      ["物料", batch.name || batch.code],
      ["批次", batch.batchNo],
      ["领料数量", `${formatQuantity(materialIssueState.qty)} ${batch.unit || ""}`],
      ["库位", materialIssueState.location || batch.location || "-"],
      ["FEFO", advice.reasonRequired ? "非推荐 / 需原因" : "推荐"],
      ["原因", materialIssueState.overrideReason || "-"],
      ["备注", materialIssueState.note || "-"],
    ]);
  }

  if (materialIssueState.result) {
    const result = materialIssueState.result;
    document.getElementById("issue-result-summary").innerHTML = issueCardGrid([
      ["工单", result.issue?.workOrderId || materialIssueState.workOrderId],
      ["物料", result.issue?.materialName || batch?.name || materialIssueState.materialCode],
      ["批次", result.movement?.batchNo || materialIssueState.batchNo],
      ["本次领料", `${formatQuantity(result.movement?.qty)} ${result.issue?.unit || batch?.unit || ""}`],
      ["剩余库存", `${formatQuantity(result.movement?.afterQty)} ${result.issue?.unit || batch?.unit || ""}`],
      ["操作人", result.issue?.operator || mobileState.currentUser?.name || "-"],
      ["成功时间", new Date(result.issue?.createdAt || result.movement?.createdAt || Date.now()).toLocaleString("zh-CN")],
    ]);
  }

  const footer = document.getElementById("material-issue-footer");
  footer.classList.toggle("hidden", isResult);
  const backButton = document.getElementById("issue-back-btn");
  const nextButton = document.getElementById("issue-next-btn");
  backButton.textContent = materialIssueState.step === "workOrder" ? "返回首页" : "返回上一步";
  nextButton.textContent = materialIssueState.step === "confirm" ? (mobileState.materialIssueSubmitting ? "正在领料…" : "确认领料") : "下一步";
  const canContinue =
    (materialIssueState.step === "workOrder" && Boolean(order)) ||
    (materialIssueState.step === "batch" && Boolean(batch)) ||
    materialIssueState.step === "input" ||
    materialIssueState.step === "confirm";
  nextButton.disabled = !canContinue || mobileState.materialIssueSubmitting || mobileState.materialIssueSubmitUnknown;
  backButton.disabled = mobileState.materialIssueSubmitting;
  document.getElementById("material-issue-close").disabled = mobileState.materialIssueSubmitting;
  document.getElementById("material-issue-unknown").classList.toggle("hidden", !mobileState.materialIssueSubmitUnknown);

  document
    .querySelectorAll("#material-issue-section input, #material-issue-section textarea, #material-issue-section button")
    .forEach((element) => {
      if (["issue-next-btn", "issue-back-btn", "material-issue-close", "issue-refresh-check-btn"].includes(element.id)) return;
      element.disabled = mobileState.materialIssueSubmitting;
    });
}

function applyWorkOrderFromUrlQuery() {
  const url = new URL(window.location.href);
  const workOrderValue = url.searchParams.get("workOrder") || url.searchParams.get("order") || url.searchParams.get("workCode");
  if (!workOrderValue) return;
  const ok = applyWorkOrderCode(workOrderValue, false);
  if (!ok) return;
  setWorkOrderScanStatus("已从工单二维码进入，可直接报工。");
  showToast("工单已自动带入");
}

function applyBatchFromUrlQuery() {
  const url = new URL(window.location.href);
  const batchValue = url.searchParams.get("batch");
  if (!batchValue) return;
  const ok = applyBatchCode(batchValue, false);
  if (!ok) return;
  document.getElementById("stock-type").value = "in";
  updateStockMode();
  setScanStatus("已从扫码链接带入批次，可直接提交入库或改成出库。");
  openWorkflowSheet("stock", { stockType: "in" });
  showToast("批次已自动带入");
}

function cameraElements(target) {
  const config = {
    workOrder: ["workorder-camera-btn", "workorder-stop-btn", "workorder-scan-video", "workorder-camera-wrap"],
    batch: ["scan-camera-btn", "scan-stop-btn", "scan-video", "scan-camera-wrap"],
    issueWorkOrder: ["issue-workorder-camera-btn", "issue-workorder-stop-btn", "issue-workorder-video", "issue-workorder-camera-wrap"],
    issueBatch: ["issue-batch-camera-btn", "issue-batch-stop-btn", "issue-batch-video", "issue-batch-camera-wrap"],
  }[target] || ["scan-camera-btn", "scan-stop-btn", "scan-video", "scan-camera-wrap"];
  return {
    isWorkOrderScan: target === "workOrder" || target === "issueWorkOrder",
    startButton: document.getElementById(config[0]),
    stopButton: document.getElementById(config[1]),
    video: document.getElementById(config[2]),
    cameraWrap: document.getElementById(config[3]),
  };
}

function updateCameraButtons(target, mode = "idle") {
  const { startButton, stopButton } = cameraElements(target);
  if (!startButton || !stopButton) return;
  startButton.textContent = mode === "starting" ? "正在启动…" : mode === "active" ? "摄像头已启动" : "启动摄像头";
  startButton.disabled = mode !== "idle";
  stopButton.disabled = mode === "idle";
}

function isAbortError(error) {
  return error?.name === "AbortError" || /aborted|aborterror/i.test(String(error?.message || ""));
}

function createCameraError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function prepareCameraPreview(video, cameraWrap) {
  cameraWrap.classList.remove("hidden", "camera-active");
  cameraWrap.setAttribute("aria-hidden", "false");
  video.hidden = false;
  ["display", "visibility", "opacity", "width", "height"].forEach((property) => {
    video.style.removeProperty(property);
  });
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.setAttribute("autoplay", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("muted", "");
}

async function waitForCameraPreview(video, timeoutMs = 10000) {
  const stream = video.srcObject;
  const liveTrack = stream?.getVideoTracks?.().find((track) => track.readyState === "live");
  if (!liveTrack) throw createCameraError("NotReadableError", "摄像头没有返回可用视频流");

  if (video.paused) {
    try {
      await video.play();
    } catch (error) {
      if (!isAbortError(error)) throw error;
    }
  }

  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    await new Promise((resolve, reject) => {
      let timer = 0;
      const cleanup = () => {
        window.clearTimeout(timer);
        ["loadedmetadata", "loadeddata", "canplay", "playing", "resize"].forEach((eventName) => {
          video.removeEventListener(eventName, handleReady);
        });
        video.removeEventListener("error", handleError);
      };
      const handleReady = () => {
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(createCameraError("NotReadableError", "摄像头预览无法播放"));
      };
      timer = window.setTimeout(() => {
        cleanup();
        reject(createCameraError("NotReadableError", "摄像头预览启动超时"));
      }, timeoutMs);
      ["loadedmetadata", "loadeddata", "canplay", "playing", "resize"].forEach((eventName) => {
        video.addEventListener(eventName, handleReady);
      });
      video.addEventListener("error", handleError, { once: true });
    });
  }

  if (video.paused) await video.play();
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  if (!video.videoWidth || !video.videoHeight) {
    throw createCameraError("NotReadableError", "摄像头没有返回可见画面");
  }
}

function stopVideoTracks(video) {
  const stream = video?.srcObject;
  if (stream?.getTracks) stream.getTracks().forEach((track) => track.stop());
  if (video) video.srcObject = null;
}

async function disposeScanner(scanner) {
  if (!scanner) return;
  try {
    if (typeof scanner.pause === "function") {
      await scanner.pause(true);
    } else {
      scanner.stop();
    }
  } catch (error) {
    if (!isAbortError(error)) console.debug("停止摄像头时出现非致命异常", error);
  }
  try {
    scanner.destroy();
  } catch (error) {
    if (!isAbortError(error)) console.debug("销毁扫码器时出现非致命异常", error);
  }
  await new Promise((resolve) => window.setTimeout(resolve, 320));
}

async function stopCameraScan(options = {}) {
  const previousTarget = scanState.target;
  const scanner = scanState.scanner;
  scanState.requestId += 1;
  scanState.scanner = null;
  scanState.active = false;
  scanState.starting = false;
  scanState.target = "";

  ["workOrder", "batch", "issueWorkOrder", "issueBatch"].forEach((target) => {
    const { video, cameraWrap } = cameraElements(target);
    cameraWrap.classList.add("hidden");
    cameraWrap.classList.remove("camera-active");
    cameraWrap.setAttribute("aria-hidden", "true");
    updateCameraButtons(target, "idle");
    stopVideoTracks(video);
  });
  const previousCleanup = scanState.cleanupPromise;
  const cleanupPromise = (async () => {
    await previousCleanup;
    await disposeScanner(scanner);
  })();
  scanState.cleanupPromise = cleanupPromise.catch(() => {});
  await cleanupPromise;

  if (!options.keepStatus) {
    if (previousTarget === "workOrder") setWorkOrderScanStatus("摄像头已停止。也可以直接粘贴工单码。");
    if (previousTarget === "batch") setScanStatus("摄像头已停止。也可以直接粘贴批次码。");
    if (previousTarget === "issueWorkOrder") document.getElementById("issue-workorder-status").textContent = "摄像头已停止。也可以手动输入工单码。";
    if (previousTarget === "issueBatch") document.getElementById("issue-batch-status").textContent = "摄像头已停止。也可以手动输入批次码。";
  }
}

async function handleScannedCode(result) {
  if (!scanState.active) return;
  const value = typeof result === "string" ? result : result?.data;
  if (!value) return;

  const target = scanState.target;
  const handler = {
    workOrder: applyWorkOrderCode,
    batch: applyBatchCode,
    issueWorkOrder: applyMaterialIssueWorkOrder,
    issueBatch: applyMaterialIssueBatch,
  }[target];
  const ok = handler?.(value);
  if (!ok) {
    if (target === "workOrder") {
      setWorkOrderScanStatus("二维码已识别，但不是本系统的工单码，请更换二维码。");
    } else if (target === "batch") {
      setScanStatus("二维码已识别，但不是本系统的物料批次码，请更换二维码。");
    }
    return;
  }

  await stopCameraScan({ keepStatus: true });
  if (target === "workOrder") {
    setWorkOrderScanStatus("已识别二维码，工单已带入，可直接报工。");
  } else if (target === "batch") {
    setScanStatus("已识别二维码，批次已带入，可直接提交出入库。");
  } else if (target === "issueWorkOrder") {
    document.getElementById("issue-workorder-status").textContent = "工单识别成功，请确认后进入下一步。";
  } else if (target === "issueBatch") {
    document.getElementById("issue-batch-status").textContent = "物料批次识别成功，请确认后进入下一步。";
  }
  showToast("二维码识别成功");
}

function cameraErrorMessage(error) {
  if (!window.isSecureContext || error?.name === "SecurityError") return "当前环境无法访问摄像头，请确认使用 HTTPS 打开系统。";
  if (error?.name === "NotAllowedError") return "未获得相机权限，请在浏览器设置中允许访问相机。";
  if (error?.name === "NotFoundError") return "未检测到可用摄像头，可改为手动输入。";
  if (error?.name === "NotReadableError") return "摄像头可能被其他应用占用，请关闭其他应用后重试。";
  if (error?.name === "NotSupportedError") return "当前浏览器不支持摄像头扫码，请手动输入二维码内容。";
  return "相机启动失败，请重试或手动输入。";
}

async function startCameraScan(target = "batch") {
  if (scanState.starting || (scanState.active && scanState.target === target)) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = window.isSecureContext ? "当前浏览器不支持摄像头扫码，请手动输入二维码内容。" : "当前环境无法访问摄像头，请确认使用 HTTPS 打开系统。";
    if (target === "workOrder") setWorkOrderScanStatus(message);
    else if (target === "batch") setScanStatus(message);
    else document.getElementById(target === "issueWorkOrder" ? "issue-workorder-status" : "issue-batch-status").textContent = message;
    return;
  }

  await stopCameraScan({ keepStatus: true });
  const requestId = scanState.requestId + 1;
  scanState.requestId = requestId;
  scanState.starting = true;
  scanState.target = target;
  updateCameraButtons(target, "starting");
  const { isWorkOrderScan, video, cameraWrap } = cameraElements(target);
  const startingMessage = "正在启动摄像头，请稍候…";
  if (target === "workOrder") setWorkOrderScanStatus(startingMessage);
  else if (target === "batch") setScanStatus(startingMessage);
  else document.getElementById(target === "issueWorkOrder" ? "issue-workorder-status" : "issue-batch-status").textContent = startingMessage;
  let scanner = null;

  try {
    if (requestId !== scanState.requestId) return;

    prepareCameraPreview(video, cameraWrap);
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    if (requestId !== scanState.requestId) return;

    scanner = new QrScanner(video, handleScannedCode, {
      preferredCamera: "environment",
      maxScansPerSecond: 8,
      highlightScanRegion: true,
      returnDetailedScanResult: true,
      onDecodeError: () => {},
    });
    scanState.scanner = scanner;
    window.requestAnimationFrame(() => cameraWrap.scrollIntoView({ block: "nearest" }));
    await scanner.start();
    if (requestId !== scanState.requestId || scanState.scanner !== scanner) {
      return;
    }
    await waitForCameraPreview(video);
    if (requestId !== scanState.requestId || scanState.scanner !== scanner) return;
    cameraWrap.classList.add("camera-active");
    scanState.starting = false;
    scanState.active = true;
    updateCameraButtons(target, "active");
    if (target === "workOrder") {
      setWorkOrderScanStatus("摄像头已开启，请将工单二维码完整放入取景框。");
    } else if (target === "batch") {
      setScanStatus("摄像头已开启，请将物料批次二维码完整放入取景框。");
    } else {
      document.getElementById(target === "issueWorkOrder" ? "issue-workorder-status" : "issue-batch-status").textContent =
        `摄像头已开启，请将${isWorkOrderScan ? "工单" : "物料批次"}二维码完整放入取景框。`;
    }
  } catch (error) {
    const isCurrentRequest = requestId === scanState.requestId;
    if (!isCurrentRequest) return;
    if (scanState.scanner === scanner) scanState.scanner = null;
    await disposeScanner(scanner);
    stopVideoTracks(video);
    cameraWrap.classList.add("hidden");
    cameraWrap.classList.remove("camera-active");
    cameraWrap.setAttribute("aria-hidden", "true");
    scanState.starting = false;
    scanState.active = false;
    scanState.target = "";
    updateCameraButtons(target, "idle");
    console.error("相机启动失败", error);
    const message = cameraErrorMessage(error);
    if (target === "workOrder") {
      setWorkOrderScanStatus(message);
    } else if (target === "batch") {
      setScanStatus(message);
    } else {
      document.getElementById(target === "issueWorkOrder" ? "issue-workorder-status" : "issue-batch-status").textContent = message;
    }
  }
}

function renderAll() {
  applyRoleMode();
  if (!mobileState.currentUser) return;
  renderSummary();
  renderTasks();
  renderReportForm();
  renderStockForm();
  renderMaterialIssue();
}

async function loadState() {
  mobileState.data = await api("/api/state");
  renderAll();
  applyWorkOrderFromUrlQuery();
  applyBatchFromUrlQuery();
}

async function loadSession() {
  const result = await api("/api/me");
  mobileState.currentUser = result.user;
  renderUser();
  await loadState();
}

function logout() {
  if (mobileState.materialIssueSubmitting) {
    showToast("领料正在提交，请等待结果");
    return;
  }
  closeWorkflowSheet();
  resetMaterialIssue();
  clearToken();
  mobileState.currentUser = null;
  mobileState.data = null;
  mobileState.selectedOrderId = "";
  mobileState.scanValue = "";
  mobileState.workOrderScanValue = "";
  document.getElementById("login-error").textContent = "";
  renderUser();
  setLoggedIn(false);
}

function scrollToTarget(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.scrollIntoView({ block: "start", behavior: "smooth" });
}

function setActiveQuickAction(action) {
  ["action-primary", "action-secondary", "action-tertiary", "action-material-issue"].forEach((id) => {
    const button = document.getElementById(id);
    button.classList.toggle("primary-action", button.getAttribute("data-action") === action);
  });
}

function setActiveBottomNav(id) {
  document.querySelectorAll(".bottom-item").forEach((item) => {
    item.classList.toggle("active", item.id === id);
  });
}

function lockPageScroll() {
  if (sheetState.locked) return;
  sheetState.scrollY = window.scrollY;
  sheetState.locked = true;
  document.body.style.top = `-${sheetState.scrollY}px`;
  document.body.classList.add("sheet-open");
}

function unlockPageScroll() {
  if (!sheetState.locked) return;
  const scrollY = sheetState.scrollY;
  sheetState.locked = false;
  document.body.classList.remove("sheet-open");
  document.body.style.top = "";
  window.requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "auto" }));
}

function openWorkflowSheet(kind, options = {}) {
  void stopCameraScan({ keepStatus: true });
  const reportSheet = document.getElementById("report-section");
  const stockSheet = document.getElementById("stock-section");
  const materialIssueSheet = document.getElementById("material-issue-section");
  const isReport = kind === "report";
  const isStock = kind === "stock";
  const isMaterialIssue = kind === "materialIssue";

  if (isStock && options.stockType) {
    document.getElementById("stock-type").value = options.stockType;
    updateStockMode();
  }

  reportSheet.classList.toggle("open", isReport);
  stockSheet.classList.toggle("open", isStock);
  materialIssueSheet.classList.toggle("open", isMaterialIssue);
  reportSheet.setAttribute("aria-hidden", String(!isReport));
  stockSheet.setAttribute("aria-hidden", String(!isStock));
  materialIssueSheet.setAttribute("aria-hidden", String(!isMaterialIssue));
  document.getElementById("sheet-backdrop").classList.remove("hidden");
  lockPageScroll();
  window.setTimeout(() => {
    const sheet = isReport ? reportSheet : isStock ? stockSheet : materialIssueSheet;
    sheet.querySelector(".workflow-sheet-body").scrollTop = 0;
  }, 40);

  if (isReport) {
    setActiveQuickAction("scan-work");
    setActiveBottomNav("nav-two");
  } else if (isStock) {
    const action = document.getElementById("stock-type").value === "out" ? "stock-out" : "stock-in";
    setActiveQuickAction(action);
    setActiveBottomNav("nav-three");
  } else {
    setActiveQuickAction("material-issue");
    setActiveBottomNav("nav-one");
    renderMaterialIssue();
  }
}

function closeWorkflowSheet() {
  if (mobileState.materialIssueSubmitting) return;
  void stopCameraScan({ keepStatus: true });
  ["report-section", "stock-section", "material-issue-section"].forEach((id) => {
    const sheet = document.getElementById(id);
    sheet.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
  });
  document.getElementById("sheet-backdrop").classList.add("hidden");
  unlockPageScroll();
  setActiveBottomNav("nav-one");
}

async function submitMaterialIssue() {
  if (mobileState.materialIssueSubmitting || mobileState.materialIssueSubmitUnknown) return;
  const order = selectedMaterialIssueOrder();
  const batch = selectedMaterialIssueBatch();
  if (!order || !batch || !materialIssueState.qty) {
    setMaterialIssueError("领料信息不完整，请返回检查。");
    return;
  }

  mobileState.materialIssueSubmitting = true;
  setMaterialIssueError("");
  await stopCameraScan({ keepStatus: true });
  renderMaterialIssue();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const result = await api(`/api/work-orders/${encodeURIComponent(order.id)}/material-issues`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        materialCode: batch.code,
        batchNo: batch.batchNo,
        qty: materialIssueState.qty,
        location: materialIssueState.location || batch.location || "",
        overrideReason: materialIssueState.overrideReason,
        note: materialIssueState.note,
        operator: "前端值必须被服务端忽略",
      }),
    });
    mobileState.data = result.state;
    materialIssueState.result = result;
    materialIssueState.step = "result";
    mobileState.materialIssueSubmitting = false;
    mobileState.materialIssueSubmitUnknown = false;
    renderAll();
    showToast("领料成功");
  } catch (error) {
    mobileState.materialIssueSubmitting = false;
    const isUnknownResult = !error.status || error.name === "AbortError";
    if (isUnknownResult) {
      mobileState.materialIssueSubmitUnknown = true;
      setMaterialIssueError("提交结果未知，请先刷新库存和最近流水确认。");
    } else {
      setMaterialIssueError(error.status === 401 ? "登录状态已失效，请重新登录。" : error.status === 403 ? "当前账号没有工单领料权限。" : error.message);
    }
    renderMaterialIssue();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function refreshUnknownMaterialIssue() {
  if (!mobileState.materialIssueSubmitUnknown) return;
  const button = document.getElementById("issue-refresh-check-btn");
  button.disabled = true;
  button.textContent = "正在刷新…";
  try {
    const nextData = await api("/api/state");
    mobileState.data = nextData;
    const movement = (nextData.stockMovements || []).find(
      (item) =>
        item.workOrderId === materialIssueState.workOrderId &&
        item.materialCode === materialIssueState.materialCode &&
        item.batchNo === materialIssueState.batchNo &&
        Number(item.qty) === Number(materialIssueState.qty) &&
        item.operator === mobileState.currentUser?.name &&
        item.type === "out"
    );
    if (movement) {
      materialIssueState.result = {
        movement,
        issue: {
          workOrderId: materialIssueState.workOrderId,
          materialName: selectedMaterialIssueBatch()?.name || materialIssueState.materialCode,
          unit: selectedMaterialIssueBatch()?.unit || "",
          operator: movement.operator,
          createdAt: movement.createdAt,
        },
      };
      materialIssueState.step = "result";
      mobileState.materialIssueSubmitUnknown = false;
      setMaterialIssueError("");
      renderAll();
      return;
    }
    setMaterialIssueError("刷新后未能确认本次领料结果，请联系管理员核对，暂时不要重复提交。");
    renderAll();
  } catch {
    setMaterialIssueError("网络连接失败，表单已保留。");
  } finally {
    button.disabled = false;
    button.textContent = "刷新并核对";
  }
}

function bindEvents() {
  ["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
    document.addEventListener(eventName, (event) => event.preventDefault(), { passive: false });
  });
  document.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 1) event.preventDefault();
    },
    { passive: false },
  );
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
      mobileState.currentUser = result.user;
      setLoggedIn(true);
      renderUser();
      await loadState();
    } catch (error) {
      document.getElementById("login-error").textContent = error.message;
    }
  });

  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("admin-link").addEventListener("click", () => {
    if (token()) localStorage.setItem(adminTokenKey, token());
  });

  document.getElementById("action-material-issue").addEventListener("click", () => {
    if (!["manager", "worker"].includes(mobileState.currentUser?.role)) {
      showToast("当前账号没有工单领料权限");
      return;
    }
    if (!mobileState.materialIssueSubmitUnknown) resetMaterialIssue();
    openWorkflowSheet("materialIssue");
  });

  document.getElementById("issue-workorder-apply-btn").addEventListener("click", () => {
    applyMaterialIssueWorkOrder(document.getElementById("issue-workorder-input").value);
  });
  document.getElementById("issue-batch-apply-btn").addEventListener("click", () => {
    applyMaterialIssueBatch(document.getElementById("issue-batch-input").value);
  });
  document.getElementById("issue-workorder-camera-btn").addEventListener("click", () => void startCameraScan("issueWorkOrder"));
  document.getElementById("issue-workorder-stop-btn").addEventListener("click", () => void stopCameraScan());
  document.getElementById("issue-batch-camera-btn").addEventListener("click", () => void startCameraScan("issueBatch"));
  document.getElementById("issue-batch-stop-btn").addEventListener("click", () => void stopCameraScan());
  document.getElementById("issue-qty").addEventListener("input", renderMaterialIssue);
  document.getElementById("issue-next-btn").addEventListener("click", async () => {
    if (materialIssueState.step === "workOrder") {
      if (!selectedMaterialIssueOrder()) {
        applyMaterialIssueWorkOrder(document.getElementById("issue-workorder-input").value);
        return;
      }
      setMaterialIssueStep("batch");
      return;
    }
    if (materialIssueState.step === "batch") {
      if (!selectedMaterialIssueBatch()) {
        applyMaterialIssueBatch(document.getElementById("issue-batch-input").value);
        return;
      }
      setMaterialIssueStep("input");
      return;
    }
    if (materialIssueState.step === "input") {
      const validationError = validateMaterialIssueInput();
      if (validationError) {
        setMaterialIssueError(validationError);
        renderMaterialIssue();
        return;
      }
      setMaterialIssueError("");
      setMaterialIssueStep("confirm");
      return;
    }
    if (materialIssueState.step === "confirm") await submitMaterialIssue();
  });
  document.getElementById("issue-back-btn").addEventListener("click", () => {
    if (mobileState.materialIssueSubmitting) return;
    if (materialIssueState.step === "workOrder") {
      closeWorkflowSheet();
      return;
    }
    const previous = { batch: "workOrder", input: "batch", confirm: "input" }[materialIssueState.step];
    if (previous) setMaterialIssueStep(previous);
  });
  document.getElementById("material-issue-close").addEventListener("click", closeWorkflowSheet);
  document.getElementById("issue-continue-btn").addEventListener("click", () => resetMaterialIssue({ keepOrder: true }));
  document.getElementById("issue-restart-btn").addEventListener("click", () => resetMaterialIssue());
  document.getElementById("issue-home-btn").addEventListener("click", () => {
    resetMaterialIssue();
    closeWorkflowSheet();
  });
  document.getElementById("issue-refresh-check-btn").addEventListener("click", () => void refreshUnknownMaterialIssue());

  document.getElementById("action-primary").addEventListener("click", async () => {
    const action = document.getElementById("action-primary").getAttribute("data-action");
    if (action === "stock-in") {
      openWorkflowSheet("stock", { stockType: "in" });
      await startCameraScan("batch");
      return;
    }
    if (action === "scan-work") {
      openWorkflowSheet("report");
      await startCameraScan("workOrder");
      return;
    }
    showToast("已定位到当前工单，可直接报工");
  });

  document.getElementById("action-secondary").addEventListener("click", async () => {
    const action = document.getElementById("action-secondary").getAttribute("data-action");
    if (action === "stock-out") {
      openWorkflowSheet("stock", { stockType: "out" });
      await startCameraScan("batch");
      return;
    }
    if (action === "stock-in") {
      openWorkflowSheet("stock", { stockType: "in" });
      await startCameraScan("batch");
      return;
    }
    showToast("请在异常备注里写清楚原因");
  });

  document.getElementById("action-tertiary").addEventListener("click", async () => {
    const action = document.getElementById("action-tertiary").getAttribute("data-action");
    if (action === "refresh-tasks") {
      await loadState();
      showToast("已刷新当前待办列表");
      return;
    }
    if (action === "batch-check") {
      openWorkflowSheet("stock");
      showToast("已定位到批次表单");
      return;
    }
    if (action === "stock-out") {
      openWorkflowSheet("stock", { stockType: "out" });
      await startCameraScan("batch");
      return;
    }
    showToast("已处理");
  });

  document.getElementById("report-stage").addEventListener("change", renderMobileReportForm);

  document.getElementById("completed-qty").addEventListener("input", syncDerivedGoodQty);

  document.getElementById("bad-qty").addEventListener("input", () => {
    const badQty = Number(document.getElementById("bad-qty").value || 0);
    document.getElementById("bad-reason").classList.toggle("required-field", badQty > 0);
    syncDerivedGoodQty();
  });

  document.getElementById("mobile-report-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!mobileState.selectedOrderId || mobileState.reportSubmitting) {
      showToast("当前没有可报工工单");
      return;
    }
    const order = currentOrder();
    const processName = document.getElementById("report-stage").value;
    const remainingQty = getRemainingReportableQty(order, processName);
    const payload = {
      workOrderId: mobileState.selectedOrderId,
      processName,
      completedQty: Number(document.getElementById("completed-qty").value),
      goodQty: Number(document.getElementById("good-qty").value),
      badQty: Number(document.getElementById("bad-qty").value),
      badReason: document.getElementById("bad-reason").value.trim(),
      note: document.getElementById("report-note").value.trim(),
    };
    const validationError = validateReportPayload(payload, remainingQty);
    const errorRoot = document.getElementById("report-form-error");
    if (validationError) {
      errorRoot.textContent = validationError;
      errorRoot.classList.remove("hidden");
      showToast(validationError);
      return;
    }

    mobileState.reportSubmitting = true;
    renderMobileReportForm();
    try {
      const result = await api("/api/reports", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      mobileState.data = result.state;
      document.getElementById("completed-qty").value = "0";
      document.getElementById("good-qty").value = "0";
      document.getElementById("bad-qty").value = "0";
      document.getElementById("bad-reason").value = "";
      document.getElementById("bad-reason").classList.remove("required-field");
      document.getElementById("report-note").value = "";
      mobileState.reportSubmitting = false;
      renderAll();
      showToast("报工已同步到管理端");
    } catch (error) {
      mobileState.reportSubmitting = false;
      renderMobileReportForm();
      errorRoot.textContent = error.message;
      errorRoot.classList.remove("hidden");
      showToast(error.message);
    }
  });

  document.getElementById("stock-type").addEventListener("change", updateStockMode);
  document.getElementById("stock-qty").addEventListener("input", updateStockFefoPreview);

  document.getElementById("stock-batch").addEventListener("change", () => {
    const batchValue = document.getElementById("stock-batch").value;
    const [materialCode, batchNo] = String(batchValue || "").split("|");
    const material = findMaterial(materialCode, batchNo);
    if (!material) return;
    document.getElementById("stock-location").value = material.location || "";
    mobileState.scanValue = buildBatchCode(material);
    document.getElementById("scan-input").value = mobileState.scanValue;
    document.getElementById("scan-preview").textContent = `当前批次码：${mobileState.scanValue}`;
    updateStockFefoPreview();
  });

  document.getElementById("scan-apply-btn").addEventListener("click", () => {
    applyBatchCode(document.getElementById("scan-input").value);
  });

  document.getElementById("workorder-apply-btn").addEventListener("click", () => {
    applyWorkOrderCode(document.getElementById("workorder-scan-input").value);
  });

  document.getElementById("workorder-camera-btn").addEventListener("click", () => {
    void startCameraScan("workOrder");
  });

  document.getElementById("workorder-stop-btn").addEventListener("click", () => {
    void stopCameraScan();
  });

  document.getElementById("scan-camera-btn").addEventListener("click", () => {
    void startCameraScan("batch");
  });

  document.getElementById("scan-stop-btn").addEventListener("click", () => {
    void stopCameraScan();
  });

  document.getElementById("report-sheet-close").addEventListener("click", closeWorkflowSheet);
  document.getElementById("stock-sheet-close").addEventListener("click", closeWorkflowSheet);
  document.getElementById("sheet-backdrop").addEventListener("click", closeWorkflowSheet);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeWorkflowSheet();
  });
  window.addEventListener("pagehide", () => {
    void stopCameraScan({ keepStatus: true });
  });

  updateCameraButtons("workOrder", "idle");
  updateCameraButtons("batch", "idle");
  updateCameraButtons("issueWorkOrder", "idle");
  updateCameraButtons("issueBatch", "idle");

  document.getElementById("stock-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (mobileState.stockSubmitting) return;
    const batchValue = document.getElementById("stock-batch").value;
    if (!batchValue) {
      showToast("当前没有可操作批次");
      return;
    }
    const [materialCode, batchNo, defaultLocation] = batchValue.split("|");
    const material = findMaterial(materialCode, batchNo);
    const type = document.getElementById("stock-type").value;
    const qty = Number(document.getElementById("stock-qty").value || 0);
    const overrideReason = document.getElementById("stock-override-reason").value.trim();
    const advice = buildFefoAdvice(material, qty);
    if (type === "out" && advice.reasonRequired && !overrideReason) {
      showToast("当前批次不符合 FEFO 或已过期，请填写原因");
      return;
    }
    mobileState.stockSubmitting = true;
    updateStockMode();
    try {
      const result = await api("/api/stock-movements", {
        method: "POST",
        body: JSON.stringify({
          materialCode,
          batchNo,
          type,
          qty,
          location: document.getElementById("stock-location").value.trim() || defaultLocation,
          note: document.getElementById("stock-note").value.trim(),
          overrideReason,
        }),
      });
      const updatedBatch = (result.state.materials || []).find((item) => item.code === materialCode && item.batchNo === batchNo);
      const materialName = material?.name || updatedBatch?.name || materialCode;
      const unit = material?.unit || updatedBatch?.unit || "";
      const message = [
        `${type === "out" ? "出库成功" : "入库成功"}`,
        `物料：${materialName}`,
        `批次：${batchNo}`,
        `数量：${qty}${unit}`,
        `当前剩余库存：${updatedBatch ? `${updatedBatch.stockQty}${unit}` : "已同步到管理端"}`,
      ].join("\n");
      window.alert(message);
      mobileState.data = result.state;
      document.getElementById("stock-qty").value = "0";
      document.getElementById("stock-note").value = "";
      document.getElementById("stock-override-reason").value = "";
      mobileState.stockSubmitting = false;
      renderAll();
      showToast(type === "out" ? "出库成功" : "入库成功");
    } catch (error) {
      mobileState.stockSubmitting = false;
      updateStockMode();
      setScanStatus(error.message);
      showToast(error.message);
    }
  });

  document.querySelectorAll(".workflow-sheet input, .workflow-sheet select, .workflow-sheet textarea").forEach((field) => {
    field.addEventListener("focus", () => {
      window.setTimeout(() => field.scrollIntoView({ block: "center", behavior: "smooth" }), 180);
    });
  });

  document.querySelectorAll("[data-scroll]").forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.getAttribute("data-scroll");
      if (targetId === "report-section") {
        openWorkflowSheet("report");
        return;
      }
      if (targetId === "stock-section") {
        openWorkflowSheet("stock");
        return;
      }
      closeWorkflowSheet();
      scrollToTarget("sticky-operations");
    });
  });
}

bindEvents();

(async function bootstrap() {
  if (!token()) return;
  try {
    setLoggedIn(true);
    await loadSession();
  } catch {
    logout();
  }
})();

