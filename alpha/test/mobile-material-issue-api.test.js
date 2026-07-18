import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error("server exited before becoming ready");
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function request(baseUrl, path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  return { response, payload };
}

test("mobile material issue API grants only manager and worker and uses session operator", async () => {
  const port = 42000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: "development", DATABASE_URL: "", REQUIRE_POSTGRES: "" },
    stdio: "ignore",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, child);
    const manager = await login(baseUrl, "admin", "admin123");
    const worker = await login(baseUrl, "worker", "worker123");
    const warehouse = await login(baseUrl, "warehouse", "warehouse123");
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const orderId = `WO-MOBILE-${suffix}`;
    const materialCode = `RM-MOBILE-${suffix}`;
    const batchNo = `BATCH-${suffix}`;

    const orderCreated = await request(baseUrl, "/api/work-orders", {
      token: manager.token,
      method: "POST",
      body: {
        id: orderId,
        product: "手机端领料测试",
        plannedQty: 10,
        doneQty: 0,
        currentProcess: "备料",
        priority: "中",
        status: "生产中",
        dueAt: "2099-01-01",
        route: [{ name: "备料", status: "进行中" }],
      },
    });
    assert.equal(orderCreated.response.status, 201);
    const materialCreated = await request(baseUrl, "/api/material-items", {
      token: manager.token,
      method: "POST",
      body: { code: materialCode, name: "手机领料材料", unit: "kg", safetyQty: 0, defaultLocation: "A-01" },
    });
    assert.equal(materialCreated.response.status, 201);
    const batchCreated = await request(baseUrl, "/api/material-batches", {
      token: manager.token,
      method: "POST",
      body: {
        materialCode,
        batchNo,
        initialQty: 2,
        location: "A-01",
        receivedDate: "2098-01-01",
        expiryDate: "2099-12-31",
      },
    });
    assert.equal(batchCreated.response.status, 201);

    const unauthenticated = await request(baseUrl, `/api/work-orders/${orderId}/material-issues`, {
      method: "POST",
      body: { materialCode, batchNo, qty: 0.1 },
    });
    assert.equal(unauthenticated.response.status, 401);

    const forbidden = await request(baseUrl, `/api/work-orders/${orderId}/material-issues`, {
      token: warehouse.token,
      method: "POST",
      body: { materialCode, batchNo, qty: 0.1 },
    });
    assert.equal(forbidden.response.status, 403);

    const managerIssue = await request(baseUrl, `/api/work-orders/${orderId}/material-issues`, {
      token: manager.token,
      method: "POST",
      body: { materialCode, batchNo, qty: 0.1, operator: "伪造操作人" },
    });
    assert.equal(managerIssue.response.status, 201);
    assert.equal(managerIssue.payload.issue.operator, "管理员");
    assert.equal(managerIssue.payload.movement.afterQty, 1.9);

    const workerIssue = await request(baseUrl, `/api/work-orders/${orderId}/material-issues`, {
      token: worker.token,
      method: "POST",
      body: { materialCode, batchNo, qty: 0.2, operator: "伪造操作人" },
    });
    assert.equal(workerIssue.response.status, 201);
    assert.equal(workerIssue.payload.issue.operator, "王师傅");
    assert.equal(workerIssue.payload.movement.afterQty, 1.7);

    const paused = await request(baseUrl, `/api/work-orders/${orderId}`, {
      token: manager.token,
      method: "PUT",
      body: { status: "已暂停" },
    });
    assert.equal(paused.response.status, 200);
    const rejectedStatus = await request(baseUrl, `/api/work-orders/${orderId}/material-issues`, {
      token: worker.token,
      method: "POST",
      body: { materialCode, batchNo, qty: 0.1 },
    });
    assert.equal(rejectedStatus.response.status, 400);
    assert.match(rejectedStatus.payload.message, /当前工单状态不允许领料/);

    const workerHistory = await request(baseUrl, `/api/work-orders/${orderId}/material-issues`, { token: worker.token });
    assert.equal(workerHistory.response.status, 403);
    const workerCorrection = await request(baseUrl, `/api/stock-movements/${managerIssue.payload.movement.id}/correct`, {
      token: worker.token,
      method: "POST",
      body: { correctionReason: "不应允许" },
    });
    assert.equal(workerCorrection.response.status, 403);
    const workerTrace = await request(
      baseUrl,
      `/api/material-batches/${encodeURIComponent(batchCreated.payload.batch.id)}/work-order-issues`,
      { token: worker.token }
    );
    assert.equal(workerTrace.response.status, 403);
  } finally {
    child.kill();
  }
});
