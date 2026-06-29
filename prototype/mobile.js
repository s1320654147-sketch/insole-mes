const mobileState = {
  selectedOrderId: "WO-240629-03",
  orders: [
    {
      id: "WO-240629-03",
      product: "减震鞋垫",
      qty: 100,
      done: 72,
      stage: "修边",
      status: "生产中",
      due: "今晚 21:00",
      route: ["修边", "检验", "包装 / 入库"],
    },
    {
      id: "WO-240629-01",
      product: "运动鞋垫",
      qty: 80,
      done: 36,
      stage: "成型 / 压制",
      status: "生产中",
      due: "明天 18:00",
      route: ["成型 / 压制", "修边", "检验", "包装 / 入库"],
    },
    {
      id: "WO-240629-02",
      product: "儿童鞋垫",
      qty: 60,
      done: 0,
      stage: "备料",
      status: "待领料",
      due: "07-01 16:00",
      route: ["备料", "裁切 / 开料", "成型 / 压制", "修边", "检验"],
    },
  ],
  batches: [
    { id: "EVA-240615-A", material: "EVA 发泡片", location: "A-01" },
    { id: "POR-240620-B", material: "PORON 缓震层", location: "B-02" },
    { id: "GLU-240601-C", material: "热熔胶", location: "C-04" },
  ],
};

function currentOrder() {
  return mobileState.orders.find((order) => order.id === mobileState.selectedOrderId);
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 1500);
}

function renderTasks() {
  const root = document.getElementById("task-list");
  root.innerHTML = mobileState.orders
    .map((order) => {
      const percent = Math.round((order.done / order.qty) * 100);
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
            <span>当前：${order.stage}</span>
            <span>交期：${order.due}</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${percent}%"></div></div>
          <div class="task-footer">
            <span>计划 ${order.qty} 双</span>
            <span>完成 ${order.done} 双</span>
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
  stageSelect.innerHTML = (order?.route || []).map((stage) => `<option value="${stage}">${stage}</option>`).join("");
}

function renderStockForm() {
  const select = document.getElementById("stock-batch");
  select.innerHTML = mobileState.batches
    .map((batch) => `<option value="${batch.id}">${batch.id} · ${batch.material} · ${batch.location}</option>`)
    .join("");
}

function bindEvents() {
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

  document.getElementById("mobile-report-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const goodQty = Number(document.getElementById("good-qty").value || 0);
    const order = currentOrder();
    if (order) {
      order.done = Math.min(order.qty, order.done + goodQty);
      renderTasks();
    }
    document.getElementById("good-qty").value = "0";
    document.getElementById("bad-qty").value = "0";
    document.getElementById("report-note").value = "";
    showToast("报工已提交");
  });

  document.getElementById("stock-form").addEventListener("submit", (event) => {
    event.preventDefault();
    showToast("入库记录已提交");
  });

  document.querySelectorAll("[data-scroll]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".bottom-item").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      document.getElementById(button.getAttribute("data-scroll")).scrollIntoView({ block: "start" });
    });
  });
}

function init() {
  renderTasks();
  renderReportForm();
  renderStockForm();
  bindEvents();
}

init();
