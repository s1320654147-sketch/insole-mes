const tokenKey = "insole_mes_alpha_token_mobile";
const adminTokenKey = "insole_mes_alpha_token_admin";

const mobileState = {
  selectedOrderId: "",
  currentUser: null,
  data: null,
  scanValue: "",
  workOrderScanValue: "",
};

const scanState = {
  stream: null,
  timer: null,
  detector: null,
  active: false,
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
              <div class="task-title">${order.product}</div>
              <div class="task-code">${order.id}</div>
            </div>
            <span class="status ${pendingClass}">${order.status}</span>
          </div>
          <div class="task-meta">
            <span>当前：${order.currentProcess}</span>
            <span>交期：${order.dueAt}</span>
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

function renderReportForm() {
  const order = currentOrder();
  const stageSelect = document.getElementById("report-stage");
  const disabled = !order;

  document.getElementById("selected-order-label").textContent = order ? order.id : "暂无工单";
  stageSelect.innerHTML = order
    ? (order.route || []).map((stage) => `<option value="${stage.name}" ${stage.name === order.currentProcess ? "selected" : ""}>${stage.name}</option>`).join("")
    : '<option value="">暂无可报工工单</option>';

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

  ["report-stage", "good-qty", "bad-qty", "report-note", "report-submit-btn"].forEach((id) => {
    document.getElementById(id).disabled = disabled;
  });
}

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
  scrollToTarget("report-section");
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
  scrollToTarget("scan-section");
  showToast("批次已自动带入");
}

function stopCameraScan(options = {}) {
  if (scanState.timer) {
    window.clearTimeout(scanState.timer);
    scanState.timer = null;
  }
  if (scanState.stream) {
    scanState.stream.getTracks().forEach((track) => track.stop());
    scanState.stream = null;
  }
  scanState.detector = null;
  scanState.active = false;
  scanState.target = "";
  document.getElementById("workorder-camera-wrap").classList.add("hidden");
  document.getElementById("scan-camera-wrap").classList.add("hidden");
  if (!options.keepStatus) {
    setWorkOrderScanStatus("摄像头已停止。也可以直接粘贴工单码。");
    setScanStatus("摄像头已停止。也可以直接粘贴批次码。");
  }
}

async function scanLoop(video) {
  if (!scanState.active || !scanState.detector) return;
  try {
    const barcodes = await scanState.detector.detect(video);
    const result = barcodes.find((item) => item.rawValue);
    if (result?.rawValue) {
      const ok = scanState.target === "workOrder" ? applyWorkOrderCode(result.rawValue) : applyBatchCode(result.rawValue);
      if (ok) {
        if (scanState.target === "workOrder") {
          setWorkOrderScanStatus("已识别二维码，工单已带入。");
        } else {
          setScanStatus("已识别二维码，批次已带入。");
        }
        stopCameraScan({ keepStatus: true });
        return;
      }
    }
  } catch {
    // ignore per-frame errors
  }
  scanState.timer = window.setTimeout(() => scanLoop(video), 350);
}

async function startCameraScan(target = "batch") {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("当前浏览器不支持摄像头");
    return;
  }
  if (!("BarcodeDetector" in window)) {
    showToast("当前浏览器原生扫码支持有限，请先粘贴批次码");
    if (target === "workOrder") {
      setWorkOrderScanStatus("当前浏览器不支持原生扫码，建议先用工单码粘贴模拟，或用微信扫码打开工单链接。");
    } else {
      setScanStatus("当前浏览器不支持原生扫码，建议先用批次码粘贴模拟。");
    }
    return;
  }

  try {
    stopCameraScan();
    scanState.target = target;
    const isWorkOrderScan = target === "workOrder";
    const video = document.getElementById(isWorkOrderScan ? "workorder-scan-video" : "scan-video");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    const formats = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : [];
    const detectorFormats = formats.includes("qr_code") ? ["qr_code"] : undefined;

    scanState.stream = stream;
    scanState.detector = detectorFormats ? new BarcodeDetector({ formats: detectorFormats }) : new BarcodeDetector();
    scanState.active = true;
    video.srcObject = stream;
    document.getElementById(isWorkOrderScan ? "workorder-camera-wrap" : "scan-camera-wrap").classList.remove("hidden");
    await video.play();
    if (isWorkOrderScan) {
      setWorkOrderScanStatus("摄像头已开启，请对准工单二维码。");
    } else {
      setScanStatus("摄像头已开启，请对准物料批次二维码。");
    }
    await scanLoop(video);
  } catch (error) {
    stopCameraScan();
    if (target === "workOrder") {
      setWorkOrderScanStatus("摄像头开启失败，请检查权限或直接粘贴工单码。");
    } else {
      setScanStatus("摄像头开启失败，请检查权限或直接粘贴批次码。");
    }
    showToast(error.message || "摄像头开启失败");
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
  stopCameraScan();
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
      document.getElementById("stock-type").value = "in";
      updateStockMode();
      scrollToTarget("scan-section");
      return;
    }
    if (action === "scan-work") {
      scrollToTarget("workorder-scan-section");
      await startCameraScan("workOrder");
      return;
    }
    showToast("已定位到当前工单，可直接报工");
  });

  document.getElementById("action-secondary").addEventListener("click", async () => {
    const action = document.getElementById("action-secondary").getAttribute("data-action");
    if (action === "stock-out") {
      document.getElementById("stock-type").value = "out";
      updateStockMode();
      scrollToTarget("scan-section");
      await startCameraScan("batch");
      return;
    }
    if (action === "stock-in") {
      document.getElementById("stock-type").value = "in";
      updateStockMode();
      scrollToTarget("scan-section");
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
      scrollToTarget("stock-form");
      showToast("已定位到批次表单");
      return;
    }
    if (action === "stock-out") {
      document.getElementById("stock-type").value = "out";
      updateStockMode();
      scrollToTarget("scan-section");
      await startCameraScan("batch");
      return;
    }
    showToast("已处理");
  });

  document.getElementById("mobile-report-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!mobileState.selectedOrderId) {
      showToast("当前没有可报工工单");
      return;
    }
    try {
      const result = await api("/api/reports", {
        method: "POST",
        body: JSON.stringify({
          workOrderId: mobileState.selectedOrderId,
          processName: document.getElementById("report-stage").value,
          goodQty: Number(document.getElementById("good-qty").value || 0),
          badQty: Number(document.getElementById("bad-qty").value || 0),
          note: document.getElementById("report-note").value.trim(),
        }),
      });
      mobileState.data = result.state;
      document.getElementById("good-qty").value = "0";
      document.getElementById("bad-qty").value = "0";
      document.getElementById("report-note").value = "";
      renderAll();
      showToast("报工已同步到管理端");
    } catch (error) {
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
      document.querySelectorAll(".bottom-item").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      scrollToTarget(targetId);
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

