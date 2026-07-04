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
    assert.equal(order.doneQty, 2);
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
      /不能超过当前工序剩余数量 2/
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
      completedQty: 5,
      goodQty: 5,
      badQty: 0,
      operator: "测试工人",
    });
    order = final.state.workOrders.find((item) => item.id === orderId);
    assert.equal(order.status, "已完成");
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
      /不能超过当前工序剩余数量 1/
    );
  });
});
