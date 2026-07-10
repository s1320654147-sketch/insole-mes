import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFefoIssuePlan, createStore } from "../src/store.js";

async function withTestStore(run) {
  const rootDir = await mkdtemp(join(tmpdir(), "insole-mes-work-order-issue-"));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    const store = await createStore(rootDir);
    await run(store);
  } finally {
    if (previousDatabaseUrl) {
      process.env.DATABASE_URL = previousDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function createOrder(store, suffix = "001") {
  return store.createWorkOrder({
    id: `WO-ISSUE-${suffix}`,
    product: "领料追溯测试鞋垫",
    plannedQty: 10,
    doneQty: 0,
    currentProcess: "备料",
    priority: "中",
    status: "待领料",
    route: [{ name: "备料", status: "待开始" }],
    operator: "测试管理员",
  });
}

async function createMaterial(store, code, name = "测试 PU") {
  return store.createMaterialItem({
    code,
    name,
    spec: "测试规格",
    unit: "kg",
    safetyQty: 0,
    defaultLocation: "A-01",
    operator: "测试管理员",
  });
}

async function createBatch(store, input) {
  return store.createMaterialBatch({
    location: "A-01",
    receivedDate: "2099-01-01",
    expiryDate: "2099-12-31",
    operator: "测试管理员",
    ...input,
  });
}

test("manual work order issue supports decimals and links inventory movement", async () => {
  await withTestStore(async (store) => {
    const order = await createOrder(store);
    await createMaterial(store, "RM-ISSUE-001", "PU 热塑材料");
    await createBatch(store, {
      materialCode: "RM-ISSUE-001",
      batchNo: "ISSUE-EARLY",
      initialQty: 10,
      expiryDate: "2099-02-01",
    });

    const result = await store.createWorkOrderMaterialIssue(order.workOrder.id, {
      materialCode: "RM-ISSUE-001",
      batchNo: "ISSUE-EARLY",
      qty: 0.5,
      note: "备料试用",
      operator: "测试管理员",
    });

    assert.equal(result.movement.type, "out");
    assert.equal(result.movement.source, "work_order_issue");
    assert.equal(result.movement.qty, 0.5);
    assert.equal(result.issue.stockMovementId, result.movement.id);
    assert.equal(result.issue.isFefoRecommended, true);
    assert.equal(result.state.materialBatches.find((item) => item.batchNo === "ISSUE-EARLY").stockQty, 9.5);
    assert.equal(result.state.workOrderMaterialIssues.length, 1);
    assert.equal(result.state.stockMovements.find((item) => item.id === result.movement.id).workOrderId, order.workOrder.id);

    const issues = await store.getWorkOrderMaterialIssues(order.workOrder.id);
    assert.equal(issues.issues.length, 1);
    assert.equal(issues.issues[0].status, "已领料");

    await store.correctStockMovement(result.movement.id, {
      correctionReason: "测试冲正领料",
      operator: "测试管理员",
    });
    const corrected = await store.getWorkOrderMaterialIssues(order.workOrder.id);
    assert.equal(corrected.issues.length, 1);
    assert.equal(corrected.issues[0].status, "已冲正");
    assert.equal(corrected.issues[0].netQty, 0);
    const correctedState = await store.getState("manager");
    assert.equal(correctedState.materialBatches.find((item) => item.batchNo === "ISSUE-EARLY").stockQty, 10);
    assert.equal(correctedState.workOrderMaterialIssues.length, 1);
    assert.equal(correctedState.stockMovements.find((item) => item.correctionOfMovementId === result.movement.id).workOrderId, order.workOrder.id);
  });
});

test("manual work order issue rejects missing records, invalid quantities, and wrong batch ownership", async () => {
  await withTestStore(async (store) => {
    const order = await createOrder(store, "002");
    await createMaterial(store, "RM-ISSUE-A", "材料 A");
    await createMaterial(store, "RM-ISSUE-B", "材料 B");
    await createBatch(store, { materialCode: "RM-ISSUE-A", batchNo: "BATCH-A", initialQty: 2 });
    await createBatch(store, { materialCode: "RM-ISSUE-B", batchNo: "BATCH-B", initialQty: 2 });

    await assert.rejects(
      () => store.createWorkOrderMaterialIssue("WO-NOT-FOUND", { materialCode: "RM-ISSUE-A", batchNo: "BATCH-A", qty: 1, operator: "测试管理员" }),
      /工单不存在/
    );
    await assert.rejects(
      () => store.createWorkOrderMaterialIssue(order.workOrder.id, { materialCode: "RM-NOT-FOUND", batchNo: "BATCH-A", qty: 1, operator: "测试管理员" }),
      /物料档案不存在/
    );
    await assert.rejects(
      () => store.createWorkOrderMaterialIssue(order.workOrder.id, { materialCode: "RM-ISSUE-A", batchNo: "BATCH-NOT-FOUND", qty: 1, operator: "测试管理员" }),
      /物料批次不存在/
    );
    await assert.rejects(
      () => store.createWorkOrderMaterialIssue(order.workOrder.id, { materialCode: "RM-ISSUE-A", batchNo: "BATCH-B", qty: 1, operator: "测试管理员" }),
      /物料批次不存在.*所选物料/
    );
    await assert.rejects(
      () => store.createWorkOrderMaterialIssue(order.workOrder.id, { materialCode: "RM-ISSUE-A", batchNo: "BATCH-A", qty: 0, operator: "测试管理员" }),
      /出入库数量必须大于 0/
    );
    await assert.rejects(
      () => store.createWorkOrderMaterialIssue(order.workOrder.id, { materialCode: "RM-ISSUE-A", batchNo: "BATCH-A", qty: 2.01, operator: "测试管理员" }),
      /出库数量不能大于当前库存/
    );
  });
});

test("manual work order issue applies existing FEFO and expired-batch rules", async () => {
  await withTestStore(async (store) => {
    const order = await createOrder(store, "003");
    await createMaterial(store, "RM-ISSUE-FEFO", "FEFO 材料");
    await createBatch(store, {
      materialCode: "RM-ISSUE-FEFO",
      batchNo: "EARLY",
      initialQty: 5,
      expiryDate: "2099-02-01",
    });
    await createBatch(store, {
      materialCode: "RM-ISSUE-FEFO",
      batchNo: "LATE",
      initialQty: 5,
      expiryDate: "2099-03-01",
    });

    await assert.rejects(
      () => store.createWorkOrderMaterialIssue(order.workOrder.id, { materialCode: "RM-ISSUE-FEFO", batchNo: "LATE", qty: 1, operator: "测试管理员" }),
      /FEFO.*EARLY/
    );
    const override = await store.createWorkOrderMaterialIssue(order.workOrder.id, {
      materialCode: "RM-ISSUE-FEFO",
      batchNo: "LATE",
      qty: 1,
      overrideReason: "客户指定此批次",
      operator: "测试管理员",
    });
    assert.equal(override.issue.isFefoRecommended, false);
    assert.equal(override.issue.overrideReason, "客户指定此批次");

    await createMaterial(store, "RM-ISSUE-EXPIRED", "过期测试材料");
    await createBatch(store, {
      materialCode: "RM-ISSUE-EXPIRED",
      batchNo: "EXPIRED",
      initialQty: 2,
      receivedDate: "2025-01-01",
      expiryDate: "2025-01-31",
    });
    await assert.rejects(
      () => store.createWorkOrderMaterialIssue(order.workOrder.id, { materialCode: "RM-ISSUE-EXPIRED", batchNo: "EXPIRED", qty: 1, operator: "测试管理员" }),
      /已过期.*原因/
    );
    const forced = await store.createWorkOrderMaterialIssue(order.workOrder.id, {
      materialCode: "RM-ISSUE-EXPIRED",
      batchNo: "EXPIRED",
      qty: 1,
      overrideReason: "研发过期材料验证",
      operator: "测试管理员",
    });
    assert.equal(forced.issue.isFefoRecommended, false);
    assert.equal(forced.issue.overrideReason, "研发过期材料验证");
  });
});

test("FEFO plan keeps a usable unit when a legacy material has a numeric unit value", () => {
  const plan = buildFefoIssuePlan(
    "RM-LEGACY-UNIT",
    0.5,
    {
      materialItems: [{ code: "RM-LEGACY-UNIT", unit: "20" }],
      materialBatches: [
        {
          id: "legacy-unit-batch",
          materialCode: "RM-LEGACY-UNIT",
          batchNo: "LEGACY-UNIT-001",
          stockQty: 1,
          receivedDate: "2099-01-01",
          expiryDate: "2099-12-31",
        },
      ],
    },
    { now: new Date("2099-01-01T00:00:00Z") }
  );

  assert.equal(plan.unit, "kg");
  assert.equal(plan.plan[0].unit, "kg");
});
