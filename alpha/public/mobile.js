const tokenKey = "insole_mes_alpha_token_mobile";

const mobileState = {
  selectedOrderId: "",
  currentUser: null,
  data: null,
};

const roleLabels = {
  manager: "管理端",
  worker: "工人",
  warehouse: "仓库",
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
  if (!response.ok) throw new Error(payload.message || "请求失败");
  return payload;
}

function setLoggedIn(value) {
  document.getElementById("login-screen").classList.toggle("hidden", value);
  document.getElementById("mobile-app").classList.toggle("hidden", !value);
}

function renderUser() {
  const user = mobileState.currentUser;
  document.getElementById("current-user").textContent = user ? `${user.name} · ${roleLabels[user.role] || user.role}` : "未登录";
}

function currentOrder() {
  return mobileState.data.workOrders.find((order) => order.id === mobileState.selectedOrderId);
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 1500);
}

function renderSummary() {
  const pending = mobileState.data.workOrders.filter((order) => order.status !== "已完工").length;
  const done = mobileState.data.workOrders.reduce((sum, order) => sum + Number(order.doneQty || 0), 0);
  const alerts = mobileState.data.alerts.filter((item) => item.status === "open").length;
  document.getElementById("summary-strip").innerHTML = `
    <div><span class="summary-value">${pending}</span><span class="summary-label">待办工序</span></div>
    <div><span class="summary-value">${done}</span><span class="summary-label">累计完成</span></div>
    <div><span class="summary-value">${alerts}</span><span class="summary-label">异常/预警</span></div>
  `;
}

function renderTasks() {
  const root = document.getElementById("task-list");
  root.innerHTML = mobileState.data.workOrders
    .map((order) => {
      const percent = Math.round((order.doneQty / order.plannedQty) * 100);
      const isSelected = order.id === mobileState.selectedOrderId;
      return `
        <button class="task-card ${isSelected ? "active" : ""}" data-order-id="${order.id}">
          <div class="task-top">
            <div>
              <div class="task-title">${order.product}</div>
              <div class="task-code">${order.id}</div>
            </div>
            <span class="status ${order.status === "待领料" ? "pending" : ""}">${order.status}</span>
          </div>
          <div class="task-meta">
            <span>当前：${order.currentProcess}</span>
            <span>交期：${order.dueAt}</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${percent}%"></div></div>
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
      renderTasks();
      renderReportForm();
    });
  });
}

function renderReportForm() {
  const order = currentOrder();
  const stageSelect = document.getElementById("report-stage");
  document.getElementById("selected-order-label").textContent = order ? order.id : "未选择";
  stageSelect.innerHTML = (order?.route || []).map((stage) => `<option value="${stage.name}" ${stage.name === order.currentProcess ? "selected" : ""}>${stage.name}</option>`).join("");
}

function renderStockForm() {
  const select = document.getElementById("stock-batch");
  select.innerHTML = mobileState.data.materials
    .map((item) => `<option value="${item.code}|${item.batchNo}|${item.location}">${item.batchNo} · ${item.name} · ${item.location}</option>`)
    .join("");
}

function renderAll() {
  if (!mobileState.selectedOrderId && mobileState.data.workOrders[0]) mobileState.selectedOrderId = mobileState.data.workOrders[0].id;
  renderSummary();
  renderTasks();
  renderReportForm();
  renderStockForm();
}

async function loadState() {
  mobileState.data = await api("/api/state");
  renderAll();
}

async function loadSession() {
  const result = await api("/api/me");
  mobileState.currentUser = result.user;
  renderUser();
  await loadState();
}

function logout() {
  clearToken();
  mobileState.currentUser = null;
  mobileState.data = null;
  document.getElementById("login-error").textContent = "";
  renderUser();
  setLoggedIn(false);
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
      setLoggedIn(true);
      renderUser();
      await loadState();
    } catch (error) {
      document.getElementById("login-error").textContent = error.message;
    }
  });

  document.getElementById("logout-btn").addEventListener("click", logout);

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-action");
      const messageMap = {
        "scan-work": "已模拟扫码进入当前工单",
        "stock-in": "请在下方填写入库数量",
        exception: "请在异常备注里填写原因",
      };
      showToast(messageMap[action]);
    });
  });

  document.getElementById("mobile-report-form").addEventListener("submit", async (event) => {
    event.preventDefault();
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
  });

  document.getElementById("stock-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const [materialCode, batchNo, defaultLocation] = document.getElementById("stock-batch").value.split("|");
    const result = await api("/api/stock-movements", {
      method: "POST",
      body: JSON.stringify({
        materialCode,
        batchNo,
        type: "in",
        qty: Number(document.getElementById("stock-qty").value || 0),
        location: document.getElementById("stock-location").value.trim() || defaultLocation,
      }),
    });
    mobileState.data = result.state;
    document.getElementById("stock-qty").value = "0";
    renderAll();
    showToast("入库已同步到管理端");
  });

  document.querySelectorAll("[data-scroll]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".bottom-item").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      document.getElementById(button.getAttribute("data-scroll")).scrollIntoView({ block: "start" });
    });
  });
}

bindEvents();
renderUser();

if (token()) {
  setLoggedIn(true);
  loadSession().catch(() => logout());
}
