import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../src/store.js";

async function withTestStore(run) {
  const rootDir = await mkdtemp(join(tmpdir(), "insole-mes-report-"));
  try {
    const store = await createStore(rootDir);
    await run(store);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("report validation and process progression form a production loop", async () => {
  await withTestStore(async (store) => {
    const created = await store.createWorkOrder({
      product: "月底打样测试鞋垫",
      plannedQty: 5,
      doneQty: 0,
      currentProcess: "备料",
      priority: "高",
      status: "待开始",
      dueAt: "",
      route: [
        { name: "备料", status: "待开始" },
        { name: "成型", status: "待开始" },
      ],
      operator: "测试管理员",
    });
    const orderId = created.workOrder.id;

    const first = await store.createReport({
      workOrderId: orderId,
      processName: "备料",
      completedQty: 3,
      goodQty: 2,
      badQty: 1,
      badReason: "来料毛边",
      note: "隔离不良品",
      operator: "测试工人",
    });
    assert.equal(first.report.completedQty, 3);
    assert.equal(first.report.badReason, "来料毛边");
    let order = first.state.workOrders.find((item) => item.id === orderId);
    assert.equal(order.doneQty, 0);
    assert.equal(order.currentProcess, "备料");
    assert.equal(order.route[0].status, "进行中");

    await assert.rejects(
      () =>
        store.createReport({
          workOrderId: orderId,
          processName: "备料",
          completedQty: 1,
          goodQty: 0,
          badQty: 1,
          badReason: "",
          operator: "测试工人",
        }),
      /必须填写不良原因/
    );

    await assert.rejects(
      () =>
        store.createReport({
          workOrderId: orderId,
          processName: "备料",
          completedQty: 3,
          goodQty: 3,
          badQty: 0,
          operator: "测试工人",
        }),
      /最多还可报 2/
    );

    const second = await store.createReport({
      workOrderId: orderId,
      processName: "备料",
      completedQty: 2,
      goodQty: 2,
      badQty: 0,
      operator: "测试工人",
    });
    order = second.state.workOrders.find((item) => item.id === orderId);
    assert.equal(order.currentProcess, "成型");
    assert.equal(order.route[0].status, "已完成");
    assert.equal(order.route[1].status, "进行中");

    const final = await store.createReport({
      workOrderId: orderId,
      processName: "成型",
      completedQty: 4,
      goodQty: 4,
      badQty: 0,
      operator: "测试工人",
    });
    order = final.state.workOrders.find((item) => item.id === orderId);
    assert.equal(order.status, "已完成");
    assert.equal(order.doneQty, 4);
    assert.equal(order.route[1].status, "已完成");
    assert.equal(final.state.reports.filter((item) => item.workOrderId === orderId).length, 3);
  });
});

test("legacy reports without completedQty remain readable for remaining quantity validation", async () => {
  await withTestStore(async (store) => {
    const created = await store.createWorkOrder({
      product: "兼容测试鞋垫",
      plannedQty: 4,
      doneQty: 0,
      currentProcess: "备料",
      status: "生产中",
      route: [{ name: "备料", status: "进行中" }],
      operator: "测试管理员",
    });

    await store.createReport({
      workOrderId: created.workOrder.id,
      processName: "备料",
      goodQty: 3,
      badQty: 0,
      operator: "测试工人",
    });

    await assert.rejects(
      () =>
        store.createReport({
          workOrderId: created.workOrder.id,
          processName: "备料",
          completedQty: 2,
          goodQty: 2,
          badQty: 0,
          operator: "测试工人",
        }),
      /最多还可报 1/
    );
  });
});

async function createFlowOrder(store, routeNames = ["A", "B", "C"]) {
  const created = await store.createWorkOrder({
    product: "数量流转测试鞋垫",
    plannedQty: 10,
    doneQty: 0,
    currentProcess: routeNames[0],
    priority: "中",
    status: "待开始",
    dueAt: "",
    route: routeNames.map((name) => ({ name, status: "待开始" })),
    operator: "测试管理员",
  });
  return created.workOrder.id;
}

function reportInput(workOrderId, processName, goodQty, badQty = 0, badReason = "") {
  return {
    workOrderId,
    processName,
    completedQty: goodQty + badQty,
    goodQty,
    badQty,
    badReason,
    operator: "测试工人",
  };
}

test("previous-process defects reject downstream over-reporting and allow its good quantity", async () => {
  await withTestStore(async (store) => {
    const orderId = await createFlowOrder(store, ["A", "B"]);
    await store.createReport(reportInput(orderId, "A", 9, 1, "A 工序损耗"));

    await assert.rejects(
      () => store.createReport(reportInput(orderId, "B", 10)),
      /上一工序良品数为 9，本工序最多还可报 9，不能报 10/
    );

    const accepted = await store.createReport(reportInput(orderId, "B", 9));
    const order = accepted.state.workOrders.find((item) => item.id === orderId);
    assert.equal(order.status, "已完成");
    assert.equal(order.doneQty, 9);
    assert.equal(order.route[1].status, "已完成");
  });
});

test("defects continue reducing transferable quantity across later processes", async () => {
  await withTestStore(async (store) => {
    const orderId = await createFlowOrder(store);
    await store.createReport(reportInput(orderId, "A", 9, 1, "A 工序损耗"));
    await store.createReport(reportInput(orderId, "B", 8, 1, "B 工序损耗"));

    await assert.rejects(
      () => store.createReport(reportInput(orderId, "C", 9)),
      /上一工序良品数为 8，本工序最多还可报 8，不能报 9/
    );

    const accepted = await store.createReport(reportInput(orderId, "C", 8));
    const order = accepted.state.workOrders.find((item) => item.id === orderId);
    assert.equal(order.status, "已完成");
    assert.equal(order.doneQty, 8);
    assert.deepEqual(
      order.route.map((step) => step.status),
      ["已完成", "已完成", "已完成"]
    );
  });
});

test("multiple partial reports on one process cannot exceed its input limit", async () => {
  await withTestStore(async (store) => {
    const orderId = await createFlowOrder(store, ["A"]);
    await store.createReport(reportInput(orderId, "A", 4, 1, "首次不良"));

    await assert.rejects(
      () => store.createReport(reportInput(orderId, "A", 5, 1, "再次不良")),
      /本工序最多还可报 5，不能报 6/
    );
  });
});

test("backend requires completed quantity to equal good plus bad quantity", async () => {
  await withTestStore(async (store) => {
    const orderId = await createFlowOrder(store, ["A"]);
    await assert.rejects(
      () =>
        store.createReport({
          ...reportInput(orderId, "A", 8, 1, "数量不一致"),
          completedQty: 10,
        }),
      /必须等于良品数与不良数之和/
    );
  });
});
