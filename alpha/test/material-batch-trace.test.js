import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMaterialBatchWorkOrderTrace, createStore, sumDecimalQuantities } from "../src/store.js";

async function withTestStore(run) {
  const rootDir = await mkdtemp(join(tmpdir(), "insole-mes-material-trace-"));
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    REQUIRE_POSTGRES: process.env.REQUIRE_POSTGRES,
    NODE_ENV: process.env.NODE_ENV,
  };
  try {
    delete process.env.DATABASE_URL;
    delete process.env.REQUIRE_POSTGRES;
    process.env.NODE_ENV = "test";
    const store = await createStore(rootDir);
    await run(store, rootDir);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function createFixture(store, { materialCode = "RM-TRACE-A", batchNo = "TRACE-001", initialQty = 20 } = {}) {
  const orderA = await store.createWorkOrder({
    id: "WO-TRACE-A",
    product: "Trace product A",
    plannedQty: 10,
    currentProcess: "Prep",
    route: [{ name: "Prep", status: "Pending" }],
    operator: "manager",
  });
  const orderB = await store.createWorkOrder({
    id: "WO-TRACE-B",
    product: "Trace product B",
    plannedQty: 10,
    currentProcess: "Prep",
    route: [{ name: "Prep", status: "Pending" }],
    operator: "manager",
  });
  await store.createMaterialItem({ code: materialCode, name: materialCode, unit: "kg", safetyQty: 0, operator: "manager" });
  const batch = await store.createMaterialBatch({
    materialCode,
    batchNo,
    initialQty,
    location: "A-01",
    receivedDate: "2099-01-01",
    expiryDate: "2099-12-31",
    operator: "manager",
  });
  return { orderA: orderA.workOrder, orderB: orderB.workOrder, batch: batch.batch };
}

async function readRawStore(rootDir) {
  return JSON.parse(await readFile(join(rootDir, "data", "alpha-store.json"), "utf8"));
}

async function writeRawStore(rootDir, state) {
  await writeFile(join(rootDir, "data", "alpha-store.json"), JSON.stringify(state, null, 2), "utf8");
}

test("empty batch returns basic information and zero trace statistics", async () => {
  await withTestStore(async (store) => {
    const { batch } = await createFixture(store, { initialQty: 1 });
    const trace = await store.getMaterialBatchWorkOrderIssues(batch.id);
    assert.equal(trace.batch.id, batch.id);
    assert.equal(trace.batch.batchNo, "TRACE-001");
    assert.deepEqual(trace.summary, {
      historicalIssueCount: 0,
      historicalWorkOrderCount: 0,
      activeWorkOrderCount: 0,
      historicalQty: 0,
      historicalIssueQty: 0,
      effectiveNetQty: 0,
      activeIssueCount: 0,
      correctedIssueCount: 0,
      correctedQty: 0,
      unknownIssueCount: 0,
      unknownWorkOrderCount: 0,
      unknownQty: 0,
    });
    assert.deepEqual(trace.workOrders, []);
    assert.deepEqual(trace.issues, []);
  });
});

test("single work order single issue is active and includes original movement details", async () => {
  await withTestStore(async (store) => {
    const { orderA, batch } = await createFixture(store, { initialQty: 5 });
    const created = await store.createWorkOrderMaterialIssue(orderA.id, {
      materialCode: batch.materialCode,
      batchNo: batch.batchNo,
      qty: 0.5,
      note: "single issue",
      operator: "manager",
    });
    const trace = await store.getMaterialBatchWorkOrderIssues(batch.id);
    assert.equal(trace.summary.historicalIssueCount, 1);
    assert.equal(trace.summary.historicalWorkOrderCount, 1);
    assert.equal(trace.summary.activeWorkOrderCount, 1);
    assert.equal(trace.summary.historicalQty, 0.5);
    assert.equal(trace.summary.effectiveNetQty, 0.5);
    assert.equal(trace.workOrders[0].issues[0].status, "active");
    assert.equal(trace.workOrders[0].issues[0].stockMovement.id, created.movement.id);
    assert.equal(trace.workOrders[0].issues[0].correctionMovement, null);
  });
});

test("same work order multiple issues aggregate without floating point display noise", async () => {
  await withTestStore(async (store) => {
    const { orderA, batch } = await createFixture(store, { initialQty: 10 });
    await store.createWorkOrderMaterialIssue(orderA.id, { materialCode: batch.materialCode, batchNo: batch.batchNo, qty: 0.1, operator: "manager" });
    await store.createWorkOrderMaterialIssue(orderA.id, { materialCode: batch.materialCode, batchNo: batch.batchNo, qty: 0.2, operator: "manager" });
    const trace = await store.getMaterialBatchWorkOrderIssues(batch.id);
    assert.equal(trace.summary.historicalIssueCount, 2);
    assert.equal(trace.summary.historicalWorkOrderCount, 1);
    assert.equal(trace.summary.historicalQty, 0.3);
    assert.equal(trace.summary.effectiveNetQty, 0.3);
    assert.equal(trace.workOrders[0].historicalQty, 0.3);
    assert.equal(trace.workOrders[0].issues.length, 2);
    assert.equal(sumDecimalQuantities([0.1, 0.2, 0.3]), 0.6);
  });
});

test("multiple work orders sort by latest issue and count only active work orders as effective", async () => {
  await withTestStore(async (store, rootDir) => {
    const { orderA, orderB, batch } = await createFixture(store, { initialQty: 20 });
    const first = await store.createWorkOrderMaterialIssue(orderA.id, { materialCode: batch.materialCode, batchNo: batch.batchNo, qty: 1, operator: "manager" });
    const second = await store.createWorkOrderMaterialIssue(orderB.id, { materialCode: batch.materialCode, batchNo: batch.batchNo, qty: 2, operator: "manager" });
    const third = await store.createWorkOrderMaterialIssue(orderA.id, { materialCode: batch.materialCode, batchNo: batch.batchNo, qty: 0.5, operator: "manager" });
    const raw = await readRawStore(rootDir);
    raw.workOrderMaterialIssues.find((item) => item.id === first.issue.id).createdAt = "2099-01-01T00:00:00.000Z";
    raw.workOrderMaterialIssues.find((item) => item.id === second.issue.id).createdAt = "2099-01-03T00:00:00.000Z";
    raw.workOrderMaterialIssues.find((item) => item.id === third.issue.id).createdAt = "2099-01-02T00:00:00.000Z";
    await writeRawStore(rootDir, raw);
    const trace = await store.getMaterialBatchWorkOrderIssues(batch.id);
    assert.deepEqual(trace.workOrders.map((item) => item.workOrderId), [orderB.id, orderA.id]);
    assert.deepEqual(trace.workOrders.find((item) => item.workOrderId === orderA.id).issues.map((item) => item.id), [third.issue.id, first.issue.id]);
    assert.equal(trace.summary.activeWorkOrderCount, 2);
    assert.equal(trace.summary.historicalWorkOrderCount, 2);
    assert.equal(trace.summary.historicalQty, 3.5);
    assert.equal(trace.summary.effectiveNetQty, 3.5);
  });
});

test("partial and full correction preserve history while excluding corrected quantity from effective totals", async () => {
  await withTestStore(async (store) => {
    const { orderA, batch } = await createFixture(store, { initialQty: 20 });
    const first = await store.createWorkOrderMaterialIssue(orderA.id, { materialCode: batch.materialCode, batchNo: batch.batchNo, qty: 2, operator: "manager" });
    const second = await store.createWorkOrderMaterialIssue(orderA.id, { materialCode: batch.materialCode, batchNo: batch.batchNo, qty: 3, operator: "manager" });
    await store.correctStockMovement(first.movement.id, { correctionReason: "partial correction", operator: "manager" });
    let trace = await store.getMaterialBatchWorkOrderIssues(batch.id);
    assert.equal(trace.summary.historicalQty, 5);
    assert.equal(trace.summary.effectiveNetQty, 3);
    assert.equal(trace.summary.correctedQty, 2);
    assert.equal(trace.summary.activeWorkOrderCount, 1);
    assert.deepEqual(trace.issues.map((item) => item.status).sort(), ["active", "corrected"]);
    await store.correctStockMovement(second.movement.id, { correctionReason: "full correction", operator: "manager" });
    trace = await store.getMaterialBatchWorkOrderIssues(batch.id);
    assert.equal(trace.summary.historicalQty, 5);
    assert.equal(trace.summary.effectiveNetQty, 0);
    assert.equal(trace.summary.correctedQty, 5);
    assert.equal(trace.summary.activeWorkOrderCount, 0);
    assert.equal(trace.workOrders[0].status, "corrected");
  });
});

test("unknown movements use JSON compatibility matching and never cross same batch numbers", async () => {
  await withTestStore(async (store, rootDir) => {
    const fixtureA = await createFixture(store, { materialCode: "RM-TRACE-A", batchNo: "SAME-BATCH", initialQty: 10 });
    await store.createMaterialItem({ code: "RM-TRACE-B", name: "RM-TRACE-B", unit: "kg", safetyQty: 0, operator: "manager" });
    const fixtureB = await store.createMaterialBatch({
      id: "BATCH-TRACE-B",
      materialCode: "RM-TRACE-B",
      batchNo: "SAME-BATCH",
      initialQty: 10,
      location: "B-01",
      receivedDate: "2099-01-01",
      expiryDate: "2099-12-31",
      operator: "manager",
    });
    const raw = await readRawStore(rootDir);
    raw.workOrderMaterialIssues.push(
      { id: "legacy-no-id", workOrderId: fixtureA.orderA.id, materialCode: "RM-TRACE-A", batchNo: "SAME-BATCH", qty: 0.25, unit: "kg", stockMovementId: "missing-legacy", createdAt: "2099-01-02T00:00:00.000Z" },
      { id: "legacy-other-material", workOrderId: fixtureA.orderA.id, materialCode: "RM-TRACE-B", batchNo: "SAME-BATCH", qty: 99, unit: "kg", stockMovementId: "missing-other", createdAt: "2099-01-03T00:00:00.000Z" },
      { id: "wrong-explicit-id", workOrderId: fixtureA.orderA.id, materialCode: "RM-TRACE-A", batchNo: "SAME-BATCH", materialBatchId: fixtureB.batch.id, qty: 88, unit: "kg", stockMovementId: "missing-explicit", createdAt: "2099-01-04T00:00:00.000Z" },
    );
    await writeRawStore(rootDir, raw);
    const trace = await store.getMaterialBatchWorkOrderIssues(fixtureA.batch.id);
    assert.equal(trace.summary.historicalIssueCount, 1);
    assert.equal(trace.summary.unknownIssueCount, 1);
    assert.equal(trace.summary.unknownWorkOrderCount, 1);
    assert.equal(trace.summary.unknownQty, 0.25);
    assert.equal(trace.issues[0].id, "legacy-no-id");
    assert.equal(trace.issues[0].status, "unknown");
    assert.equal(trace.issues.some((item) => item.id === "legacy-other-material"), false);
    assert.equal(trace.issues.some((item) => item.id === "wrong-explicit-id"), false);
  });
});

test("trace builder returns unknown for missing movement and retains original plus correction data", () => {
  const trace = buildMaterialBatchWorkOrderTrace({
    batch: { id: "BATCH-UNIT", materialCode: "RM-UNIT", batchNo: "UNIT", initialQty: 10, stockQty: 5 },
    material: { code: "RM-UNIT", name: "Unit", unit: "kg" },
    workOrders: [{ id: "WO-UNIT", product: "Unit product", status: "Running" }],
    issues: [
      { id: "active", workOrderId: "WO-UNIT", materialCode: "RM-UNIT", batchNo: "UNIT", materialBatchId: "BATCH-UNIT", qty: 1, stockMovementId: "m-active", createdAt: "2099-01-01" },
      { id: "corrected", workOrderId: "WO-UNIT", materialCode: "RM-UNIT", batchNo: "UNIT", materialBatchId: "BATCH-UNIT", qty: 2, stockMovementId: "m-corrected", createdAt: "2099-01-02" },
      { id: "unknown", workOrderId: "WO-UNIT", materialCode: "RM-UNIT", batchNo: "UNIT", materialBatchId: "BATCH-UNIT", qty: 3, stockMovementId: "missing", createdAt: "2099-01-03" },
    ],
    stockMovements: [
      { id: "m-active", materialCode: "RM-UNIT", batchNo: "UNIT", type: "out", qty: 1, createdAt: "2099-01-01" },
      { id: "m-corrected", materialCode: "RM-UNIT", batchNo: "UNIT", type: "out", qty: 2, correctedByMovementId: "m-correction", createdAt: "2099-01-02" },
      { id: "m-correction", materialCode: "RM-UNIT", batchNo: "UNIT", type: "in", qty: 2, correctionOfMovementId: "m-corrected", correctionReason: "test", createdAt: "2099-01-04" },
    ],
  });
  assert.deepEqual(trace.issues.map((item) => item.status), ["unknown", "corrected", "active"]);
  assert.equal(trace.summary.historicalQty, 6);
  assert.equal(trace.summary.effectiveNetQty, 1);
  assert.equal(trace.summary.unknownQty, 3);
  assert.equal(trace.issues.find((item) => item.id === "corrected").correctionMovement.id, "m-correction");
});

test("material batch trace store validates invalid and missing ids", async () => {
  await withTestStore(async (store) => {
    await assert.rejects(() => store.getMaterialBatchWorkOrderIssues(""), (error) => error.code === "INVALID_PARAMETER");
    await assert.rejects(() => store.getMaterialBatchWorkOrderIssues("not-found"), (error) => error.code === "NOT_FOUND");
  });
});

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("server exited before becoming ready");
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The server may still be loading the file store.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

test("batch trace API enforces manager access and returns 404 for a missing batch", async () => {
  const port = 41000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: join(process.cwd()),
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DATABASE_URL: "", REQUIRE_POSTGRES: "" },
    stdio: "ignore",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, child);
    const unauthorized = await fetch(`${baseUrl}/api/material-batches/missing/work-order-issues`);
    assert.equal(unauthorized.status, 401);

    const workerLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "worker", password: "worker123" }),
    });
    const worker = await workerLogin.json();
    const forbidden = await fetch(`${baseUrl}/api/material-batches/missing/work-order-issues`, { headers: { authorization: `Bearer ${worker.token}` } });
    assert.equal(forbidden.status, 403);

    const managerLogin = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    });
    const manager = await managerLogin.json();
    const invalid = await fetch(`${baseUrl}/api/material-batches/%20/work-order-issues`, { headers: { authorization: `Bearer ${manager.token}` } });
    assert.equal(invalid.status, 400);
    const missing = await fetch(`${baseUrl}/api/material-batches/trace-test-missing/work-order-issues`, { headers: { authorization: `Bearer ${manager.token}` } });
    assert.equal(missing.status, 404);
    const payload = await missing.json();
    assert.equal(payload.error, "NOT_FOUND");
    assert.equal(String(payload.message).includes("select"), false);
  } finally {
    child.kill();
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
});
