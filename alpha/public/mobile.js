const tokenKey = "insole_mes_alpha_token_mobile";
const adminTokenKey = "insole_mes_alpha_token_admin";

import QrScanner from "/vendor/qr-scanner/qr-scanner.min.js";
import {
  getProcessReportedQty as calculateProcessReportedQty,
  getRemainingReportableQty as calculateRemainingReportableQty,
  validateReportPayload,
} from "./production-metrics.js";

const mobileState = {
  selectedOrderId: "",
  currentUser: null,
  data: null,
  scanValue: "",
  workOrderScanValue: "",
  reportSubmitting: false,
};

const scanState = {
  scanner: null,
  active: false,
  starting: false,
  target: "",
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

function handoffToAdmin(tokenValue = token()) {
  if (tokenValue) {
    localStorage.setItem(adminTokenKey, tokenValue);
  }
  clearToken();
  window.location.replace("./admin.html");
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
  if (!response.ok) throw new Error(payload.message || "请求失败");
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

function extractWorkOrderPayload(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const parsedUrl = new URL(value);
    return String(parsedUrl.searchParams.get("workOrder") || parsedUrl.searchParams.get("order") || parsedUrl.searchParams.get("code") || value).trim();
  } catch {
    return value;
  }
}

function parseWorkOrderCode(rawValue) {
  const value = extractWorkOrderPayload(rawValue);
  if (!value) return null;
  if (!value.includes("|")) {
    return {
      workOrderId: value,
      processName: "",
    };
  }
  const parts = value.split("|").map((part) => part.trim());
  if (parts.length < 2 || parts[0] !== "WO") return null;
  return {
    workOrderId: parts[1],
    processName: parts.slice(2).join("|") || "",
  };
}

function extractBatchPayload(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const parsedUrl = new URL(value);
    return String(parsedUrl.searchParams.get("batch") || parsedUrl.searchParams.get("code") || value).trim();
  } catch {
    return value;
  }
}

function parseBatchCode(rawValue) {
  const value = extractBatchPayload(rawValue);
  if (!value) return null;
  const parts = value.split("|").map((part) => part.trim());
  if (parts.length < 4 || parts[0] !== "MAT") return null;
  return {
    materialCode: parts[1],
    batchNo: parts[2],
    location: parts.slice(3).join("|") || "",
  };
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

function getRoleConfig(role) {
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
  if (user.role === "manager") {
    handoffToAdmin();
    return;
  }

  const config = getRoleConfig(user.role);
  document.getElementById("login-title").textContent = config.loginTitle;
  document.getElementById("app-eyebrow").textContent = config.eyebrow;
  document.getElementById("app-title").textContent = config.title;
  document.getElementById("role-banner").textContent = config.banner;
  document.getElementById("tasks-title").textContent = config.tasksTitle;
  document.getElementById("tasks-meta").textContent = config.tasksMeta;
  document.getElementById("report-title").textContent = config.reportTitle;
  document.getElementById("admin-link").classList.toggle("hidden", user.role === "manager");

  document.getElementById("action-primary").textContent = config.primaryAction.text;
  document.getElementById("action-primary").setAttribute("data-action", config.primaryAction.action);
  document.getElementById("action-secondary").textContent = config.secondaryAction.text;
  document.getElementById("action-secondary").setAttribute("data-action", config.secondaryAction.action);
  document.getElementById("action-tertiary").textContent = config.tertiaryAction.text;
  document.getElementById("action-tertiary").setAttribute("data-action", config.tertiaryAction.action);

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
  const workOrders = mobileState.data?.workOrders || [];
  if (!workOrders.length) {
    root.innerHTML = '<div class="empty-state">当前没有待办工单。</div>';
    return;
  }

  if (!mobileState.selectedOrderId || !workOrders.some((order) => order.id === mobileState.selectedOrderId)) {
    mobileState.selectedOrderId = workOrders[0].id;
  }

  root.innerHTML = workOrders
    .map((order) => {
      const progress = order.plannedQty ? Math.round((Number(order.doneQty || 0) / Number(order.plannedQty)) * 100) : 0;
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
            <span>完成 ${order.doneQty} 双</span>
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
  const stageIndex = stages.findIndex((stage) => stage.name === selectedStage);
  const selectedStageData = stages[stageIndex] || null;
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
        <div><span>已报</span><strong>${reportedQty}</strong></div>
        <div><span>剩余</span><strong>${remainingQty}</strong></div>
      </div>
      <div class="process-description">
        第 ${stageIndex >= 0 ? stageIndex + 1 : "-"} / ${stages.length || "-"} 道 ·
        ${escapeHtml(selectedStage || "未配置工序")} ·
        ${escapeHtml(selectedStageData?.status || "状态未知")}
      </div>
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
  document.getElementById("stock-qty-label").textContent = type === "out" ? "出库数量" : "入库数量";
  document.getElementById("stock-submit-btn").textContent = type === "out" ? "提交出库" : "提交入库";
  document.getElementById("stock-title").textContent = type === "out" ? "扫码出库" : "扫码入库";
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

  ["stock-type", "stock-batch", "stock-qty", "stock-location", "stock-note", "stock-submit-btn", "scan-input", "scan-apply-btn"].forEach((id) => {
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

function stopCameraScan(options = {}) {
  if (scanState.scanner) {
    scanState.scanner.stop();
    scanState.scanner.destroy();
    scanState.scanner = null;
  }
  scanState.active = false;
  scanState.starting = false;
  scanState.target = "";
  document.getElementById("workorder-camera-wrap").classList.add("hidden");
  document.getElementById("scan-camera-wrap").classList.add("hidden");
  if (!options.keepStatus) {
    setWorkOrderScanStatus("摄像头已停止。也可以直接粘贴工单码。");
    setScanStatus("摄像头已停止。也可以直接粘贴批次码。");
  }
}

function handleScannedCode(result) {
  if (!scanState.active) return;
  const value = typeof result === "string" ? result : result?.data;
  if (!value) return;

  const target = scanState.target;
  const ok = target === "workOrder" ? applyWorkOrderCode(value) : applyBatchCode(value);
  if (!ok) {
    if (target === "workOrder") {
      setWorkOrderScanStatus("二维码已识别，但不是本系统的工单码，请更换二维码。");
    } else {
      setScanStatus("二维码已识别，但不是本系统的物料批次码，请更换二维码。");
    }
    return;
  }

  stopCameraScan({ keepStatus: true });
  if (target === "workOrder") {
    setWorkOrderScanStatus("已识别二维码，工单已带入，可直接报工。");
  } else {
    setScanStatus("已识别二维码，批次已带入，可直接提交出入库。");
  }
  showToast("二维码识别成功");
}

function cameraErrorMessage(error) {
  if (!window.isSecureContext) return "摄像头只能在 HTTPS 页面中使用，请打开 Render 的 https:// 地址。";
  if (error?.name === "NotAllowedError") return "摄像头权限被拒绝，请在浏览器设置中允许此网站使用摄像头。";
  if (error?.name === "NotFoundError") return "没有找到可用摄像头，请检查设备摄像头。";
  if (error?.name === "NotReadableError") return "摄像头正被其他应用占用，请关闭其他扫码或拍照应用后重试。";
  return error?.message || "摄像头开启失败，请检查浏览器权限。";
}

async function startCameraScan(target = "batch") {
  if (scanState.starting) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = window.isSecureContext
      ? "当前浏览器无法调用摄像头，请改用系统浏览器打开。"
      : "摄像头只能在 HTTPS 页面中使用。";
    showToast(message);
    target === "workOrder" ? setWorkOrderScanStatus(message) : setScanStatus(message);
    return;
  }

  try {
    stopCameraScan();
    scanState.starting = true;
    scanState.target = target;
    const isWorkOrderScan = target === "workOrder";
    const video = document.getElementById(isWorkOrderScan ? "workorder-scan-video" : "scan-video");
    const cameraWrap = document.getElementById(isWorkOrderScan ? "workorder-camera-wrap" : "scan-camera-wrap");

    scanState.scanner = new QrScanner(video, handleScannedCode, {
      preferredCamera: "environment",
      maxScansPerSecond: 8,
      highlightScanRegion: true,
      returnDetailedScanResult: true,
      onDecodeError: () => {},
    });
    cameraWrap.classList.remove("hidden");
    scanState.active = true;
    await scanState.scanner.start();
    scanState.starting = false;
    if (isWorkOrderScan) {
      setWorkOrderScanStatus("摄像头已开启，请将工单二维码完整放入取景框。");
    } else {
      setScanStatus("摄像头已开启，请将物料批次二维码完整放入取景框。");
    }
  } catch (error) {
    stopCameraScan();
    const message = cameraErrorMessage(error);
    if (target === "workOrder") {
      setWorkOrderScanStatus(message);
    } else {
      setScanStatus(message);
    }
    showToast(message);
  }
}

function renderAll() {
  applyRoleMode();
  if (!mobileState.currentUser || mobileState.currentUser.role === "manager") return;
  renderSummary();
  renderTasks();
  renderReportForm();
  renderStockForm();
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
  if (result.user.role === "manager") {
    handoffToAdmin();
    return;
  }
  renderUser();
  await loadState();
}

function logout() {
  closeWorkflowSheet();
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
  ["action-primary", "action-secondary", "action-tertiary"].forEach((id) => {
    const button = document.getElementById(id);
    button.classList.toggle("primary-action", button.getAttribute("data-action") === action);
  });
}

function setActiveBottomNav(id) {
  document.querySelectorAll(".bottom-item").forEach((item) => {
    item.classList.toggle("active", item.id === id);
  });
}

function openWorkflowSheet(kind, options = {}) {
  stopCameraScan({ keepStatus: true });
  const reportSheet = document.getElementById("report-section");
  const stockSheet = document.getElementById("stock-section");
  const isReport = kind === "report";

  if (!isReport && options.stockType) {
    document.getElementById("stock-type").value = options.stockType;
    updateStockMode();
  }

  reportSheet.classList.toggle("open", isReport);
  stockSheet.classList.toggle("open", !isReport);
  reportSheet.setAttribute("aria-hidden", String(!isReport));
  stockSheet.setAttribute("aria-hidden", String(isReport));
  document.getElementById("sheet-backdrop").classList.remove("hidden");
  document.body.classList.add("sheet-open");

  if (isReport) {
    setActiveQuickAction("scan-work");
    setActiveBottomNav("nav-two");
  } else {
    const action = document.getElementById("stock-type").value === "out" ? "stock-out" : "stock-in";
    setActiveQuickAction(action);
    setActiveBottomNav("nav-three");
  }
}

function closeWorkflowSheet() {
  stopCameraScan({ keepStatus: true });
  ["report-section", "stock-section"].forEach((id) => {
    const sheet = document.getElementById(id);
    sheet.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
  });
  document.getElementById("sheet-backdrop").classList.add("hidden");
  document.body.classList.remove("sheet-open");
  setActiveBottomNav("nav-one");
}

function bindEvents() {
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
      if (result.user.role === "manager") {
        handoffToAdmin(result.token);
        return;
      }
      setLoggedIn(true);
      renderUser();
      await loadState();
    } catch (error) {
      document.getElementById("login-error").textContent = error.message;
    }
  });

  document.getElementById("logout-btn").addEventListener("click", logout);

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

  document.getElementById("completed-qty").addEventListener("input", () => {
    const completedQty = Number(document.getElementById("completed-qty").value || 0);
    const goodInput = document.getElementById("good-qty");
    const badQty = Number(document.getElementById("bad-qty").value || 0);
    if (Number(goodInput.value || 0) === 0 && badQty === 0 && completedQty > 0) {
      goodInput.value = String(completedQty);
    }
  });

  document.getElementById("bad-qty").addEventListener("input", () => {
    const badQty = Number(document.getElementById("bad-qty").value || 0);
    document.getElementById("bad-reason").classList.toggle("required-field", badQty > 0);
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

  document.getElementById("stock-batch").addEventListener("change", () => {
    const batchValue = document.getElementById("stock-batch").value;
    const [materialCode, batchNo] = String(batchValue || "").split("|");
    const material = findMaterial(materialCode, batchNo);
    if (!material) return;
    document.getElementById("stock-location").value = material.location || "";
    mobileState.scanValue = buildBatchCode(material);
    document.getElementById("scan-input").value = mobileState.scanValue;
    document.getElementById("scan-preview").textContent = `当前批次码：${mobileState.scanValue}`;
  });

  document.getElementById("scan-apply-btn").addEventListener("click", () => {
    applyBatchCode(document.getElementById("scan-input").value);
  });

  document.getElementById("workorder-apply-btn").addEventListener("click", () => {
    applyWorkOrderCode(document.getElementById("workorder-scan-input").value);
  });

  document.getElementById("workorder-camera-btn").addEventListener("click", () => {
    startCameraScan("workOrder");
  });

  document.getElementById("workorder-stop-btn").addEventListener("click", () => {
    stopCameraScan();
  });

  document.getElementById("scan-camera-btn").addEventListener("click", () => {
    startCameraScan("batch");
  });

  document.getElementById("scan-stop-btn").addEventListener("click", () => {
    stopCameraScan();
  });

  document.getElementById("report-sheet-close").addEventListener("click", closeWorkflowSheet);
  document.getElementById("stock-sheet-close").addEventListener("click", closeWorkflowSheet);
  document.getElementById("sheet-backdrop").addEventListener("click", closeWorkflowSheet);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeWorkflowSheet();
  });

  document.getElementById("stock-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const batchValue = document.getElementById("stock-batch").value;
    if (!batchValue) {
      showToast("当前没有可操作批次");
      return;
    }
    const [materialCode, batchNo, defaultLocation] = batchValue.split("|");
    try {
      const result = await api("/api/stock-movements", {
        method: "POST",
        body: JSON.stringify({
          materialCode,
          batchNo,
          type: document.getElementById("stock-type").value,
          qty: Number(document.getElementById("stock-qty").value || 0),
          location: document.getElementById("stock-location").value.trim() || defaultLocation,
          note: document.getElementById("stock-note").value.trim(),
        }),
      });
      mobileState.data = result.state;
      document.getElementById("stock-qty").value = "0";
      document.getElementById("stock-note").value = "";
      renderAll();
      showToast(document.getElementById("stock-type").value === "out" ? "出库已同步到管理端" : "入库已同步到管理端");
    } catch (error) {
      showToast(error.message);
    }
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

