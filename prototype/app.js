const state = {
  currentView: "dashboard",
  selectedOrderId: "WO-240629-03",
  stats: [
    { label: "进行中生产单", value: 4, meta: "其中 2 单今天要推进到检验" },
    { label: "待处理预警", value: 3, meta: "1 个缺料，2 个临期批次" },
    { label: "打样项目", value: 6, meta: "10 到 20 双的小样要重点盯版本" },
    { label: "今日报工次数", value: 19, meta: "先按工序报工，后续再接扫码" },
  ],
  samples: [
    { id: "SP-240629-01", name: "运动鞋垫", customer: "跨境新品", version: "V3", owner: "陈工", due: "06-30", status: "打样中" },
    { id: "SP-240629-02", name: "儿童鞋垫", customer: "客户返样", version: "V2", owner: "李姐", due: "07-01", status: "待确认" },
    { id: "SP-240629-03", name: "减震鞋垫", customer: "老品优化", version: "V5", owner: "周工", due: "07-02", status: "待打样" },
  ],
  orders: [
    {
      id: "WO-240629-01",
      sampleId: "SP-240629-01",
      product: "运动鞋垫",
      qty: 80,
      done: 36,
      stage: "成型 / 压制",
      priority: "高",
      status: "生产中",
      due: "06-30 18:00",
      route: [
        { name: "备料", status: "已完成" },
        { name: "裁切 / 开料", status: "已完成" },
        { name: "成型 / 压制", status: "进行中" },
        { name: "修边", status: "待开始" },
        { name: "检验", status: "待开始" },
        { name: "包装 / 入库", status: "待开始" },
      ],
    },
    {
      id: "WO-240629-02",
      sampleId: "SP-240629-02",
      product: "儿童鞋垫",
      qty: 60,
      done: 0,
      stage: "待领料",
      priority: "中",
      status: "待领料",
      due: "07-01 16:00",
      route: [
        { name: "备料", status: "待开始" },
        { name: "裁切 / 开料", status: "待开始" },
        { name: "成型 / 压制", status: "待开始" },
        { name: "修边", status: "待开始" },
        { name: "检验", status: "待开始" },
        { name: "包装 / 入库", status: "待开始" },
      ],
    },
    {
      id: "WO-240629-03",
      sampleId: "SP-240629-03",
      product: "减震鞋垫",
      qty: 100,
      done: 72,
      stage: "修边",
      priority: "高",
      status: "生产中",
      due: "06-29 21:00",
      route: [
        { name: "备料", status: "已完成" },
        { name: "裁切 / 开料", status: "已完成" },
        { name: "成型 / 压制", status: "已完成" },
        { name: "修边", status: "进行中" },
        { name: "检验", status: "待开始" },
        { name: "包装 / 入库", status: "待开始" },
      ],
    },
  ],
  materials: [
    { code: "RM-001", name: "EVA 发泡片", spec: "3mm 黑色", stock: 86, safe: 120, unit: "张", location: "A-01", batch: "EVA-240615-A", expiry: "2026-07-15" },
    { code: "RM-002", name: "PORON 缓震层", spec: "2mm 灰色", stock: 240, safe: 180, unit: "片", location: "B-02", batch: "POR-240620-B", expiry: "2026-08-20" },
    { code: "RM-003", name: "热熔胶", spec: "鞋材专用", stock: 18, safe: 30, unit: "桶", location: "C-04", batch: "GLU-240601-C", expiry: "2026-07-03" },
    { code: "RM-004", name: "包装袋", spec: "透明自封", stock: 620, safe: 500, unit: "个", location: "D-01", batch: "PKG-240622-A", expiry: "2027-06-22" },
  ],
  activities: [
    { title: "WO-240629-03 完成成型 / 压制", meta: "王师傅 · 15:42", note: "已转入修边" },
    { title: "RM-003 触发临期预警", meta: "系统 · 15:10", note: "批次 GLU-240601-C 将于 07-03 到期" },
    { title: "SP-240629-01 更新到 V3", meta: "陈工 · 14:28", note: "表面处理要求已调整" },
    { title: "WO-240629-02 已下派", meta: "计划员 · 13:55", note: "等待领料开始" },
  ],
  alerts: [
    { title: "EVA 发泡片不足", text: "RM-001 当前库存 86 张，低于安全库存 120 张，且 WO-240629-01 还需继续消耗。" },
    { title: "热熔胶批次临期", text: "RM-003 批次 GLU-240601-C 将于 2026-07-03 到期，应优先领用或尽快补采新批次。" },
    { title: "WO-240629-03 存在延期风险", text: "减震鞋垫生产单今晚 21:00 到期，当前仍在修边工序。" },
  ],
};

const views = {
  dashboard: { title: "总览", subtitle: "先把样品、生产单、批次物料和每一步进度抓在手里。" },
  samples: { title: "样品单", subtitle: "用样品单承接打样版本、负责人和客户确认。" },
  orders: { title: "生产单", subtitle: "以生产单为中心，把领料、工序、检验和入库串起来。" },
  materials: { title: "物料库存", subtitle: "重点看批次、保质期、安全库存和缺料风险。" },
  reporting: { title: "报工台", subtitle: "V1 先按工序报工，后续再演进到扫码和移动端。" },
  alerts: { title: "预警中心", subtitle: "优先盯缺料、临期批次、延期和暂停异常。" },
};

function renderStats() {
  const root = document.getElementById("stats-grid");
  root.innerHTML = state.stats
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
  root.innerHTML = `<div class="list">${items.map(mapFn).join("")}</div>`;
}

function renderDashboard() {
  renderStats();

  renderList("focus-orders", state.orders, (order) => {
    const percent = Math.round((order.done / order.qty) * 100);
    return `
      <div class="list-item">
        <div class="item-top">
          <div class="item-title">${order.id} · ${order.product}</div>
          <span class="status ${order.status === "生产中" ? "running" : "pending"}">${order.status}</span>
        </div>
        <div class="item-meta">当前工序：${order.stage} · 交期：${order.due}</div>
        <div class="progress-row">
          <div class="progress-label"><span>完成进度</span><span>${order.done}/${order.qty}</span></div>
          <div class="progress-bar"><div class="progress-fill" style="width:${percent}%"></div></div>
        </div>
      </div>
    `;
  });

  renderList(
    "risk-list",
    state.materials.filter((item) => item.stock < item.safe),
    (item) => `
      <div class="list-item">
        <div class="item-top">
          <div class="item-title">${item.name}</div>
          <span class="status warn">低库存</span>
        </div>
        <div class="item-meta">${item.code} · 库位 ${item.location} · 批次 ${item.batch}</div>
        <div class="item-note">当前 ${item.stock} ${item.unit} / 安全库存 ${item.safe} ${item.unit}</div>
      </div>
    `
  );

  renderList("stage-board", state.orders, (order) => {
    const nextStage = order.route.find((step) => step.status === "待开始")?.name || "待完工";
    return `
      <div class="list-item">
        <div class="item-top">
          <div class="item-title">${order.product}</div>
          <span class="status ${order.status === "生产中" ? "running" : "pending"}">${order.stage}</span>
        </div>
        <div class="item-meta">${order.id} · 下一步：${nextStage}</div>
      </div>
    `;
  });

  renderList(
    "activity-list",
    state.activities,
    (item) => `
      <div class="list-item">
        <div class="item-top">
          <div class="item-title">${item.title}</div>
        </div>
        <div class="item-meta">${item.meta}</div>
        <div class="item-note">${item.note}</div>
      </div>
    `
  );
}

function renderSamples() {
  const root = document.getElementById("sample-table");
  root.innerHTML = `
    <div class="table">
      <div class="table-head sample-grid">
        <div>样品单号</div>
        <div>项目</div>
        <div>版本</div>
        <div>负责人</div>
        <div>截止</div>
        <div>状态</div>
      </div>
      ${state.samples
        .map(
          (item) => `
            <div class="table-row sample-grid">
              <div>${item.id}</div>
              <div>${item.name} / ${item.customer}</div>
              <div>${item.version}</div>
              <div>${item.owner}</div>
              <div>${item.due}</div>
              <div><span class="status pending">${item.status}</span></div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderOrders() {
  const root = document.getElementById("order-table");
  root.innerHTML = `
    <div class="table">
      <div class="table-head order-grid">
        <div>工单号</div>
        <div>产品</div>
        <div>计划/完成</div>
        <div>当前工序</div>
        <div>优先级</div>
        <div>状态</div>
      </div>
      ${state.orders
        .map(
          (order) => `
            <div class="table-row order-grid clickable ${order.id === state.selectedOrderId ? "active" : ""}" data-order-id="${order.id}">
              <div>${order.id}</div>
              <div>${order.product}</div>
              <div>${order.qty} / ${order.done}</div>
              <div>${order.stage}</div>
              <div>${order.priority}</div>
              <div><span class="status ${order.status === "生产中" ? "running" : "pending"}">${order.status}</span></div>
            </div>
          `
        )
        .join("")}
    </div>
  `;

  root.querySelectorAll("[data-order-id]").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedOrderId = row.getAttribute("data-order-id");
      renderOrders();
      renderOrderDetail();
    });
  });
}

function renderOrderDetail() {
  const order = state.orders.find((item) => item.id === state.selectedOrderId);
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
        <div class="item-meta">样品单：${order.sampleId} · 交期：${order.due}</div>
      </div>
      <div class="detail-block">
        <div class="detail-title">当前状态</div>
        <div>${order.status} · 当前工序 ${order.stage}</div>
        <div class="progress-row">
          <div class="progress-label"><span>完成进度</span><span>${order.done}/${order.qty}</span></div>
          <div class="progress-bar"><div class="progress-fill" style="width:${Math.round((order.done / order.qty) * 100)}%"></div></div>
        </div>
      </div>
      <div class="detail-block">
        <div class="detail-title">工艺路线</div>
        <div class="route-list">
          ${order.route
            .map(
              (step) => `
                <div class="route-step">
                  <span>${step.name}</span>
                  <span class="status ${step.status === "进行中" ? "running" : step.status === "待开始" ? "pending" : ""}">${step.status}</span>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
    </div>
  `;
}

function renderMaterials() {
  const root = document.getElementById("material-table");
  root.innerHTML = `
    <div class="table">
      <div class="table-head material-grid">
        <div>料号</div>
        <div>物料</div>
        <div>规格</div>
        <div>库存</div>
        <div>安全库存</div>
        <div>批次 / 库位</div>
      </div>
      ${state.materials
        .map(
          (item) => `
            <div class="table-row material-grid">
              <div>${item.code}</div>
              <div>${item.name}</div>
              <div>${item.spec}</div>
              <div>${item.stock} ${item.unit}</div>
              <div>${item.safe} ${item.unit}</div>
              <div>${item.batch} / ${item.location}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderReporting() {
  renderList(
    "reporting-queue",
    state.orders,
    (order) => `
      <div class="list-item">
        <div class="item-top">
          <div class="item-title">${order.id} · ${order.product}</div>
          <span class="status ${order.status === "生产中" ? "running" : "pending"}">${order.stage}</span>
        </div>
        <div class="item-meta">优先级 ${order.priority} · 当前完成 ${order.done}/${order.qty}</div>
      </div>
    `
  );

  const orderSelect = document.getElementById("report-order");
  orderSelect.innerHTML = state.orders.map((order) => `<option value="${order.id}">${order.id} · ${order.product}</option>`).join("");
  populateStageOptions(orderSelect.value);
}

function populateStageOptions(orderId) {
  const order = state.orders.find((item) => item.id === orderId);
  const stageSelect = document.getElementById("report-stage");
  stageSelect.innerHTML = (order?.route || []).map((step) => `<option value="${step.name}">${step.name}</option>`).join("");
}

function renderAlerts() {
  const root = document.getElementById("alerts-list");
  root.innerHTML = state.alerts
    .map(
      (item) => `
        <div class="alert-card">
          <div class="item-title">${item.title}</div>
          <div class="item-note">${item.text}</div>
        </div>
      `
    )
    .join("");
}

function setView(viewKey) {
  state.currentView = viewKey;
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.getAttribute("data-view") === viewKey);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `${viewKey}-view`);
  });
  document.getElementById("view-title").textContent = views[viewKey].title;
  document.getElementById("view-subtitle").textContent = views[viewKey].subtitle;
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => setView(item.getAttribute("data-view")));
  });

  document.getElementById("report-order").addEventListener("change", (event) => {
    populateStageOptions(event.target.value);
  });

  document.getElementById("report-form").addEventListener("submit", (event) => {
    event.preventDefault();

    const orderId = document.getElementById("report-order").value;
    const stage = document.getElementById("report-stage").value;
    const action = document.getElementById("report-action").value;
    const note = document.getElementById("report-note").value.trim() || "无备注";
    const actionMap = { start: "开工", finish: "完工", pause: "暂停" };

    state.activities.unshift({
      title: `${orderId} ${actionMap[action]} ${stage}`,
      meta: `演示用户 · 刚刚`,
      note,
    });

    if (action === "pause") {
      state.alerts.unshift({
        title: `${orderId} 工序暂停`,
        text: `${stage} 已被标记为暂停，备注：${note}`,
      });
    }

    renderDashboard();
    renderAlerts();
    document.getElementById("report-note").value = "";
    setView("dashboard");
  });
}

function init() {
  renderDashboard();
  renderSamples();
  renderOrders();
  renderOrderDetail();
  renderMaterials();
  renderReporting();
  renderAlerts();
  bindEvents();
}

init();
