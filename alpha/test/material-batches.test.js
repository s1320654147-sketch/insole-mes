import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildFefoIssuePlan,
  createStore,
  getBatchExpiryStatus,
  getMaterialStockSummary,
  normalizeLegacyMaterials,
} from "../src/store.js";

async function withTestStore(run) {
  const rootDir = await mkdtemp(join(tmpdir(), "insole-mes-material-"));
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

async function createPuMaterial(store, overrides = {}) {
  return store.createMaterialItem({
    code: "RM-PU-001",
    name: "PU 原材料",
    spec: "低温热塑",
    unit: "kg",
    safetyQty: 5,
    defaultLocation: "A-01",
    operator: "测试管理员",
    ...overrides,
  });
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function daysFromNow(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return dateOnly(date);
}

test("manager can create material items and duplicate codes are rejected", async () => {
  await withTestStore(async (store) => {
    const created = await createPuMaterial(store);
    assert.equal(created.material.code, "RM-PU-001");
    assert.equal(created.material.unit, "kg");
    assert.equal(created.material.status, "启用");
    assert.ok(created.state.materialItems.some((item) => item.code === "RM-PU-001"));

    await assert.rejects(
      () => createPuMaterial(store, { name: "重复 PU" }),
      /物料编号不能重复/
    );
  });
});

test("material items default to kg and can be edited after creation", async () => {
  await withTestStore(async (store) => {
    const created = await store.createMaterialItem({
      code: "RM-EDIT-001",
      name: "待编辑物料",
      safetyQty: 1,
      operator: "测试管理员",
    });
    assert.equal(created.material.unit, "kg");

    const updated = await store.updateMaterialItem("RM-EDIT-001", {
      name: "已编辑物料",
      spec: "新版规格",
      unit: "kg",
      safetyQty: 5,
      defaultLocation: "A-09",
      operator: "测试管理员",
    });
    assert.equal(updated.material.name, "已编辑物料");
    assert.equal(updated.material.spec, "新版规格");
    assert.equal(updated.material.safetyQty, 5);
    assert.equal(updated.material.defaultLocation, "A-09");
    const state = await store.getState("manager");
    assert.equal(state.materialItems.find((item) => item.code === "RM-EDIT-001").unit, "kg");
  });
});

test("material item unit rejects pure numbers to avoid stock quantity mistakes", async () => {
  await withTestStore(async (store) => {
    await assert.rejects(
      () =>
        store.createMaterialItem({
          code: "RM-BAD-UNIT",
          name: "错误单位物料",
          unit: "50",
          safetyQty: 1,
          operator: "测试管理员",
        }),
      /计量单位不能是纯数字/
    );
  });
});

test("material batches create inbound stock movement and derived total stock", async () => {
  await withTestStore(async (store) => {
    await createPuMaterial(store);
    const first = await store.createMaterialBatch({
      materialCode: "RM-PU-001",
      batchNo: "PU-202607-001",
      initialQty: 10,
      location: "A-01",
      receivedDate: "2026-07-07",
      expiryDate: "2026-08-06",
      supplier: "供应商 A",
      note: "采购到货",
      operator: "测试管理员",
    });

    assert.equal(first.batch.stockQty, 10);
    assert.equal(first.movement.type, "in");
    assert.equal(first.movement.beforeQty, 0);
    assert.equal(first.movement.afterQty, 10);
    assert.equal(first.state.materials.find((item) => item.code === "RM-PU-001").batchNo, "PU-202607-001");

    const second = await store.createMaterialBatch({
      materialCode: "RM-PU-001",
      batchNo: "PU-202607-002",
      initialQty: 8,
      location: "A-02",
      receivedDate: "2026-07-07",
      expiryDate: "2026-07-14",
      operator: "测试管理员",
    });
    const summary = second.state.materialSummaries.find((item) => item.materialCode === "RM-PU-001");
    assert.equal(summary.totalStockQty, 18);
    assert.equal(summary.batchCount, 2);
    assert.equal(second.state.stockMovements.filter((item) => item.materialCode === "RM-PU-001" && item.type === "in").length, 2);
  });
});

test("batch validation rejects duplicate batch under same material and invalid dates", async () => {
  await withTestStore(async (store) => {
    await createPuMaterial(store);
    await store.createMaterialItem({
      code: "RM-EVA-001",
      name: "EVA 片材",
      unit: "张",
      safetyQty: 0,
      operator: "测试管理员",
    });

    const payload = {
      materialCode: "RM-PU-001",
      batchNo: "SUP-LOT-001",
      initialQty: 10,
      location: "A-01",
      receivedDate: "2026-07-07",
      expiryDate: "2026-08-06",
      operator: "测试管理员",
    };
    await store.createMaterialBatch(payload);

    await assert.rejects(
      () => store.createMaterialBatch(payload),
      /同一物料下批次号不能重复/
    );

    const sameTextDifferentMaterial = await store.createMaterialBatch({
      ...payload,
      materialCode: "RM-EVA-001",
      location: "B-01",
    });
    assert.equal(sameTextDifferentMaterial.batch.batchNo, "SUP-LOT-001");

    await assert.rejects(
      () =>
        store.createMaterialBatch({
          ...payload,
          batchNo: "BAD-DATE",
          receivedDate: "2026-07-10",
          expiryDate: "2026-07-09",
        }),
      /保质期截止日期不能早于来料日期/
    );

    await assert.rejects(
      () =>
        store.createMaterialBatch({
          ...payload,
          batchNo: "DECIMAL-QTY",
          initialQty: 1.5,
        }),
      /入库数量不能是小数/
    );
  });
});

test("expiry status compares by date and covers used up, expired, soon, and normal", () => {
  const now = new Date(2026, 6, 7, 12, 0, 0);
  assert.equal(getBatchExpiryStatus({ stockQty: 0, expiryDate: "2026-08-01" }, now), "已用完");
  assert.equal(getBatchExpiryStatus({ stockQty: 1, expiryDate: "2026-07-06T23:59:59.000Z" }, now), "已过期");
  assert.equal(getBatchExpiryStatus({ stockQty: 1, expiryDate: "2026-08-06" }, now), "即将过期");
  assert.equal(getBatchExpiryStatus({ stockQty: 1, expiryDate: "2026-08-07" }, now), "正常");
});

test("legacy materials migrate to material items, material batches, and old batch codes remain available", async () => {
  const migrated = normalizeLegacyMaterials({
    materials: [
      {
        code: "RM-OLD-001",
        name: "历史库存",
        spec: "未分批",
        stockQty: 6,
        safetyQty: 3,
        unit: "张",
        location: "H-01",
        batchNo: "OLD-BATCH-001",
        expiryDate: "2026-12-31",
      },
    ],
  });
  assert.equal(migrated.materialItems[0].code, "RM-OLD-001");
  assert.equal(migrated.materialBatches[0].batchNo, "OLD-BATCH-001");
  assert.equal(migrated.materialBatches[0].stockQty, 6);
});

test("old stock movement API path updates batches and keeps mobile scan payload compatible", async () => {
  await withTestStore(async (store) => {
    await createPuMaterial(store);
    await store.createMaterialBatch({
      materialCode: "RM-PU-001",
      batchNo: "PU-202607-001",
      initialQty: 10,
      location: "A-01",
      receivedDate: "2026-07-07",
      expiryDate: "2026-08-06",
      operator: "测试管理员",
    });

    const out = await store.createStockMovement({
      materialCode: "RM-PU-001",
      batchNo: "PU-202607-001",
      type: "out",
      qty: 4,
      location: "A-01",
      note: "手机扫码出库",
      source: "mobile",
      operator: "测试工人",
    });
    const batch = out.state.materialBatches.find((item) => item.materialCode === "RM-PU-001" && item.batchNo === "PU-202607-001");
    assert.equal(batch.stockQty, 6);
    assert.equal(out.movement.beforeQty, 10);
    assert.equal(out.movement.afterQty, 6);

    const compat = out.state.materials.find((item) => item.code === "RM-PU-001" && item.batchNo === "PU-202607-001");
    assert.equal(compat.stockQty, 6);
    assert.equal(["MAT", compat.code, compat.batchNo, compat.location].join("|"), "MAT|RM-PU-001|PU-202607-001|A-01");

    await assert.rejects(
      () =>
        store.createStockMovement({
          materialCode: "RM-PU-001",
          batchNo: "PU-202607-001",
          type: "out",
          qty: 7,
          operator: "测试工人",
        }),
      /出库数量不能大于当前库存/
    );

    const state = await store.getState("manager");
    const summary = getMaterialStockSummary("RM-PU-001", state);
    assert.equal(summary.totalStockQty, 6);
  });
});

test("FEFO plan recommends the earliest non-expired batch and splits when needed", () => {
  const state = {
    materialItems: [{ code: "RM-FEFO-001", name: "FEFO material", unit: "kg", safetyQty: 0 }],
    materialBatches: [
      { materialCode: "RM-FEFO-001", batchNo: "LATE", stockQty: 10, location: "A-02", receivedDate: "2099-01-02", expiryDate: "2099-03-01" },
      { materialCode: "RM-FEFO-001", batchNo: "EARLY", stockQty: 6, location: "A-01", receivedDate: "2099-01-01", expiryDate: "2099-02-01" },
      { materialCode: "RM-FEFO-001", batchNo: "EXPIRED", stockQty: 99, location: "A-03", receivedDate: "2025-01-01", expiryDate: "2025-01-31" },
    ],
  };
  const plan = buildFefoIssuePlan("RM-FEFO-001", 9, state, { now: new Date("2026-07-08T00:00:00Z") });
  assert.equal(plan.recommendedBatch.batchNo, "EARLY");
  assert.deepEqual(plan.plan.map((item) => [item.batchNo, item.qty]), [
    ["EARLY", 6],
    ["LATE", 3],
  ]);
  assert.equal(plan.remainingQty, 0);
  assert.equal(plan.isEnough, true);
});

test("material summary exposes low stock and batch risk counts", async () => {
  await withTestStore(async (store) => {
    await createPuMaterial(store, { safetyQty: 50 });
    const expiredDate = daysFromNow(-1);
    const soonDate = daysFromNow(7);
    const normalDate = daysFromNow(90);
    await store.createMaterialBatch({
      materialCode: "RM-PU-001",
      batchNo: "PU-RISK-EXPIRED",
      initialQty: 2,
      location: "A-01",
      receivedDate: daysFromNow(-30),
      expiryDate: expiredDate,
      operator: "tester",
    });
    await store.createMaterialBatch({
      materialCode: "RM-PU-001",
      batchNo: "PU-RISK-SOON",
      initialQty: 3,
      location: "A-01",
      receivedDate: daysFromNow(-5),
      expiryDate: soonDate,
      operator: "tester",
    });
    await store.createMaterialBatch({
      materialCode: "RM-PU-001",
      batchNo: "PU-RISK-NORMAL",
      initialQty: 4,
      location: "A-01",
      receivedDate: daysFromNow(-5),
      expiryDate: normalDate,
      operator: "tester",
    });
    const state = await store.getState("manager");
    const summary = getMaterialStockSummary("RM-PU-001", state);
    assert.equal(summary.totalStockQty, 9);
    assert.equal(summary.lowStock, true);
    assert.equal(summary.expiredBatchCount, 1);
    assert.equal(summary.expiringSoonBatchCount, 1);
  });
});

test("outbound movement rejects non-FEFO batch without reason and allows override reason", async () => {
  await withTestStore(async (store) => {
    await createPuMaterial(store);
    await store.createMaterialBatch({
      materialCode: "RM-PU-001",
      batchNo: "PU-FEFO-EARLY",
      initialQty: 10,
      location: "A-01",
      receivedDate: "2099-01-01",
      expiryDate: "2099-02-01",
      operator: "tester",
    });
    await store.createMaterialBatch({
      materialCode: "RM-PU-001",
      batchNo: "PU-FEFO-LATE",
      initialQty: 10,
      location: "A-02",
      receivedDate: "2099-01-02",
      expiryDate: "2099-03-01",
      operator: "tester",
    });

    await assert.rejects(
      () =>
        store.createStockMovement({
          materialCode: "RM-PU-001",
          batchNo: "PU-FEFO-LATE",
          type: "out",
          qty: 2,
          location: "A-02",
          operator: "tester",
        }),
      /FEFO|PU-FEFO-EARLY/
    );

    const out = await store.createStockMovement({
      materialCode: "RM-PU-001",
      batchNo: "PU-FEFO-LATE",
      type: "out",
      qty: 2,
      location: "A-02",
      note: "manual pick",
      overrideReason: "customer specified",
      operator: "tester",
    });
    assert.equal(out.movement.afterQty, 8);
    assert.match(out.movement.note, /customer specified/);
  });
});

test("expired batch requires override reason before outbound movement", async () => {
  await withTestStore(async (store) => {
    await createPuMaterial(store);
    await store.createMaterialBatch({
      materialCode: "RM-PU-001",
      batchNo: "PU-EXPIRED",
      initialQty: 5,
      location: "A-01",
      receivedDate: "2025-01-01",
      expiryDate: "2025-01-31",
      operator: "tester",
    });

    await assert.rejects(
      () =>
        store.createStockMovement({
          materialCode: "RM-PU-001",
          batchNo: "PU-EXPIRED",
          type: "out",
          qty: 1,
          location: "A-01",
          operator: "tester",
        }),
      /已过期|过期/
    );

    const out = await store.createStockMovement({
      materialCode: "RM-PU-001",
      batchNo: "PU-EXPIRED",
      type: "out",
      qty: 1,
      location: "A-01",
      overrideReason: "R&D sample test",
      operator: "tester",
    });
    assert.equal(out.movement.afterQty, 4);
    assert.match(out.movement.note, /R&D sample test/);
  });
});

test("stock movement correction keeps original row and reverses inventory once", async () => {
  await withTestStore(async (store) => {
    await createPuMaterial(store);
    const created = await store.createMaterialBatch({
      materialCode: "RM-PU-001",
      batchNo: "PU-CORRECT-001",
      initialQty: 20,
      location: "A-01",
      receivedDate: daysFromNow(-1),
      expiryDate: daysFromNow(60),
      operator: "tester",
    });

    const correction = await store.correctStockMovement(created.movement.id, {
      correctionReason: "wrong inbound quantity",
      operator: "manager",
    });
    assert.equal(correction.movement.type, "out");
    assert.equal(correction.movement.qty, 20);
    assert.equal(correction.movement.correctionOfMovementId, created.movement.id);
    assert.equal(correction.original.correctedByMovementId, correction.movement.id);
    assert.equal(correction.state.materialBatches.find((item) => item.batchNo === "PU-CORRECT-001").stockQty, 0);

    await assert.rejects(
      () => store.correctStockMovement(created.movement.id, { correctionReason: "repeat", operator: "manager" }),
      /已经冲正|重复/
    );
  });
});

test("outbound correction adds stock back and refuses blank reason", async () => {
  await withTestStore(async (store) => {
    await createPuMaterial(store);
    await store.createMaterialBatch({
      materialCode: "RM-PU-001",
      batchNo: "PU-CORRECT-002",
      initialQty: 20,
      location: "A-01",
      receivedDate: daysFromNow(-1),
      expiryDate: daysFromNow(60),
      operator: "tester",
    });
    const out = await store.createStockMovement({
      materialCode: "RM-PU-001",
      batchNo: "PU-CORRECT-002",
      type: "out",
      qty: 6,
      location: "A-01",
      operator: "tester",
    });

    await assert.rejects(
      () => store.correctStockMovement(out.movement.id, { correctionReason: "", operator: "manager" }),
      /冲正原因/
    );

    const correction = await store.correctStockMovement(out.movement.id, {
      correctionReason: "wrong outbound quantity",
      operator: "manager",
    });
    assert.equal(correction.movement.type, "in");
    assert.equal(correction.state.materialBatches.find((item) => item.batchNo === "PU-CORRECT-002").stockQty, 20);
  });
});
