const tokenKey = "insole_mes_alpha_token";

const state = {
  currentView: "dashboard",
  selectedOrderId: "",
  data: null,
};

const views = {
  dashboard: { title: "总览", subtitle: "先把样品、生产单、批次物料和每一步进度抓在手里。" },
  samples: { title: "样品单", subtitle: "用样品单承接打样版本、负责人和客户确认。" },
  orders: { title: "生产单", subtitle: "以生产单为中心，把领料、工序、检验和入库串起来。" },
  materials: { title: "物料库存", subtitle: "重点看批次、保质期、安全库存和缺料风险。" },
  reporting: { title: "报工台", subtitle: "V1 先按工序报工，手机端提交后回流到这里。" },
  alerts: { title: "预警中心", subtitle: "优先盯缺料、临期批次、延期和暂停异常。" },
};

function token() {
  return localStorage.getItem(tokenKey);
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
  document.getElementById("app-shell").classList.toggle("hidden", !value);
}

function normalizeStatus(status) {
  if (status === "生产中" || status === "进行中") return "running";
  if (status === "待领料" || status === "待开始" || status === "待确认" || status === "待打样") return "pending";
  if (status === "high" || status === "延期" || status === "低库存") return "warn";
  return "";
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

function renderDashboard() {
  renderStats();

  renderList("focus-orders", state.data.workOrders, (order) => {
    const percent = Math.round((order.doneQty / order.plannedQty) * 100);
    return `
      <div class="list-item">
        <div class="item-top">
          <div class="item-title">${order.id} · ${order.product}</div>
          <span class="status ${normalizeStatus(order.status)}">${order.status}</span>
        </div>
        <div class="item-meta">当前工序：${order.currentProcess} · 交期：${order.dueAt}</div>
        <div class="progress-row">
          <div class="progress-label"><span>完成进度</span><span>${order.doneQty}/${order.plannedQty}</span></div>
          <div class="progress-bar"><div class="progress-fill" style="width:${percent}%"></div></div>
        </div>
      </div>
    `;
  });

  const materialRisks = state.data.materials
    .filter((item) => Number(item.stockQty) < Number(item.safetyQty))
    .map((item) => ({
      title: item.name,
      meta: `${item.code} · 库位 ${item.location} · 批次 ${item.batchNo}`,
      note: `当前 ${item.stockQty} ${item.unit} / 安全库存 ${item.safetyQty} ${item.unit}`,
      label: "低库存",
    }));
  const alertRisks = state.data.alerts.filter((item) => item.status === "open").map((item) => ({ title: item.title, meta: "系统预警", note: item.text, label: "预警" }));
  renderList("risk-list", [...materialRisks, ...alertRisks].slice(0, 6), (item) => `
    <div class="list-item">
      <div class="item-top">
        <div class="item-title">${item.title}</div>
        <span class="status warn">${item.label}</span>
      </div>
      <div class="item-meta">${item.meta}</div>
      <div class="item-note">${item.note}</div>
    </div>
  `);

  renderList("stage-board", state.data.workOrders, (order) => {
    const nextStage = order.route.find((step) => step.status === "待开始")?.name || "待完工";
    return `
      <div class="list-item">
        <div class="item-top">
          <div class="item-title">${order.product}</div>
          <span class="status ${normalizeStatus(order.status)}">${order.currentProcess}</span>
        </div>
        <div class="item-meta">${order.id} · 下一步：${nextStage}</div>
      </div>
    `;
  });

  renderList("activity-list", state.data.activities, (item) => `
    <div class="list-item">
      <div class="item-top"><div class="item-title">${item.title}</div></div>
      <div class="item-meta">${item.meta || ""}</div>
      <div class="item-note">${item.note || ""}</div>
    </div>
  `);
}

function renderSamples() {
  document.getElementById("sample-table").innerHTML = `
    <div class="table">
      <div class="table-head sample-grid">
        <div>样品单号</div><div>项目</div><div>版本</div><div>负责人</div><div>截止</div><div>状态</div>
      </div>
      ${state.data.samples
        .map(
          (item) => `
            <div class="table-row sample-grid">
              <div>${item.id}</div>
              <div>${item.name} / ${item.customer}</div>
              <div>${item.version}</div>
              <div>${item.owner}</div>
              <div>${String(item.dueDate).slice(5, 10)}</div>
              <div><span class="status ${normalizeStatus(item.status)}">${item.status}</span></div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderOrders() {
  document.getElementById("order-table").innerHTML = `
    <div class="table">
      <div class="table-head order-grid">
        <div>工单号</div><div>产品</div><div>计划/完成</div><div>当前工序</div><div>优先级</div><div>状态</div>
      </div>
      ${state.data.workOrders
        .map(
          (order) => `
            <div class="table-row order-grid clickable ${order.id === state.selectedOrderId ? "active" : ""}" data-order-id="${order.id}">
              <div>${order.id}</div>
              <div>${order.product}</div>
              <div>${order.plannedQty} / ${order.doneQty}</div>
              <div>${order.currentProcess}</div>
              <div>${order.priority}</div>
              <div><span class="status ${normalizeStatus(order.status)}">${order.status}</span></div>
            </div>
          `
        )
        .join("")}
    </div>
  `;

  document.querySelectorAll("[data-order-id]").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedOrderId = row.getAttribute("data-order-id");
      renderOrders();
      renderOrderDetail();
    });
  });
}

function renderOrderDetail() {
  const order = state.data.workOrders.find((item) => item.id === state.selectedOrderId);
  const root = document.getElementById("order-detail");
  if (!order) {
    root.innerHTML = "";
    return;
  }

  root.innerHTML = `
    <div class="detail-card">
      <div class="detail-block">
        <div class="detail-title">基本信息</div>
        <div>${order.id} · ${order.product}</div>
        <div class="item-meta">样品单：${order.sampleId} · 交期：${order.dueAt}</div>
      </div>
      <div class="detail-block">
        <div class="detail-title">当前状态</div>
        <div>${order.status} · 当前工序 ${order.currentProcess}</div>
        <div class="progress-row">
          <div class="progress-label"><span>完成进度</span><span>${order.doneQty}/${order.plannedQty}</span></div>
          <div class="progress-bar"><div class="progress-fill" style="width:${Math.round((order.doneQty / order.plannedQty) * 100)}%"></div></div>
        </div>
      </div>
      <div class="detail-block">
        <div class="detail-title">工艺路线</div>
        <div class="route-list">
          ${order.route.map((step) => `<div class="route-step"><span>${step.name}</span><span class="status ${normalizeStatus(step.status)}">${step.status}</span></div>`).join("")}
        </div>
      </div>
    </div>
  `;
}

function renderMaterials() {
  document.getElementById("material-table").innerHTML = `
    <div class="table">
      <div class="table-head material-grid">
        <div>料号</div><div>物料</div><div>规格</div><div>库存</div><div>安全库存</div><div>批次 / 库位</div>
      </div>
      ${state.data.materials
        .map(
          (item) => `
            <div class="table-row material-grid">
              <div>${item.code}</div>
              <div>${item.name}</div>
              <div>${item.spec}</div>
              <div><span class="status ${item.stockQty < item.safetyQty ? "warn" : ""}">${item.stockQty} ${item.unit}</span></div>
              <div>${item.safetyQty} ${item.unit}</div>
              <div>${item.batchNo} / ${item.location}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderReporting() {
  renderList("reporting-queue", state.data.workOrders, (order) => `
    <div class="list-item">
      <div class="item-top">
        <div class="item-title">${order.id} · ${order.product}</div>
        <span class="status ${normalizeStatus(order.status)}">${order.currentProcess}</span>
      </div>
      <div class="item-meta">优先级 ${order.priority} · 当前完成 ${order.doneQty}/${order.plannedQty}</div>
    </div>
  `);

  document.getElementById("report-table").innerHTML = `
    <div class="table">
      <div class="table-head report-grid">
        <div>工单</div><div>工序</div><div>良品</div><div>不良</div><div>备注</div><div>操作人</div>
      </div>
      ${state.data.reports
        .map(
          (item) => `
            <div class="table-row report-grid">
              <div>${item.workOrderId}</div>
              <div>${item.processName}</div>
              <div>${item.goodQty}</div>
              <div>${item.badQty}</div>
              <div>${item.note || "-"}</div>
              <div>${item.operator || "-"}</div>
            </div>
          `
        )
        .join("") || `<div class="list-item">暂无报工记录。可以打开手机端提交一次。</div>`}
    </div>
  `;
}

function renderAlerts() {
  document.getElementById("alerts-list").innerHTML = state.data.alerts
    .map((item) => `<div class="alert-card"><div class="item-title">${item.title}</div><div class="item-note">${item.text}</div></div>`)
    .join("");
}

function renderAll() {
  if (!state.selectedOrderId && state.data.workOrders[0]) state.selectedOrderId = state.data.workOrders[0].id;
  renderDashboard();
  renderSamples();
  renderOrders();
  renderOrderDetail();
  renderMaterials();
  renderReporting();
  renderAlerts();
}

function setView(viewKey) {
  state.currentView = viewKey;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.getAttribute("data-view") === viewKey));
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${viewKey}-view`));
  document.getElementById("view-title").textContent = views[viewKey].title;
  document.getElementById("view-subtitle").textContent = views[viewKey].subtitle;
}

async function loadState() {
  state.data = await api("/api/state");
  renderAll();
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => setView(item.getAttribute("data-view"))));
  document.getElementById("refresh-btn").addEventListener("click", loadState);
  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("username").value.trim(),
          password: document.getElementById("password").value,
        }),
      });
      localStorage.setItem(tokenKey, result.token);
      setLoggedIn(true);
      await loadState();
    } catch (error) {
      document.getElementById("login-error").textContent = error.message;
    }
  });
}

bindEvents();

if (token()) {
  setLoggedIn(true);
  loadState().catch(() => setLoggedIn(false));
}
