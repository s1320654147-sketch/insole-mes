import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./src/store.js";
import { createToken, verifyToken } from "./src/auth.js";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(rootDir, "public");
const qrScannerDir = join(rootDir, "node_modules", "qr-scanner");
const port = Number(process.env.PORT || 3000);
const store = await createStore(rootDir);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getBearerUser(request) {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  return verifyToken(header.slice(7));
}

function requireUser(request, response) {
  const user = getBearerUser(request);
  if (!user) {
    sendJson(response, 401, { error: "UNAUTHORIZED", message: "请先登录" });
    return null;
  }
  return user;
}

function requireRole(user, response, roles) {
  if (roles.includes(user.role)) return true;
  sendJson(response, 403, { error: "FORBIDDEN", message: "当前账号没有这个操作权限" });
  return false;
}

function isMaterialIssueBusinessError(error) {
  if (error?.code === "WORK_ORDER_STATUS_NOT_ALLOWED") return true;
  return /^(工单不存在|物料档案不存在|物料批次不存在|操作人不能为空|物料料号不能为空|物料批次不能为空|出入库数量必须大于 0|出库数量不能大于当前库存|当前批次已过期|当前不是 FEFO 推荐批次)/.test(
    String(error?.message || "")
  );
}

async function withScopedState(result, role) {
  return {
    ...result,
    state: await store.getState(role),
  };
}

async function handleApi(request, response, url) {
  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true, store: store.kind });
    return true;
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await readJson(request);
    const user = await store.findUser(body.username, body.password);
    if (!user) {
      sendJson(response, 401, { error: "LOGIN_FAILED", message: "账号或密码不正确" });
      return true;
    }
    sendJson(response, 200, {
      token: createToken({ id: user.id, name: user.name, role: user.role }),
      user: { id: user.id, name: user.name, role: user.role },
    });
    return true;
  }

  if (url.pathname === "/api/me" && request.method === "GET") {
    const user = requireUser(request, response);
    if (!user) return true;
    sendJson(response, 200, { user });
    return true;
  }

  if (url.pathname === "/api/state" && request.method === "GET") {
    const user = requireUser(request, response);
    if (!user) return true;
    sendJson(response, 200, await store.getState(user.role));
    return true;
  }

  if (url.pathname === "/api/samples" && request.method === "POST") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager"])) return true;
    const body = await readJson(request);
    const result = await store.createSample({ ...body, operator: user.name });
    sendJson(response, 201, await withScopedState(result, user.role));
    return true;
  }

  if (url.pathname.startsWith("/api/samples/") && request.method === "PUT") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager"])) return true;
    const body = await readJson(request);
    const sampleId = decodeURIComponent(url.pathname.slice("/api/samples/".length));
    const result = await store.updateSample(sampleId, { ...body, operator: user.name });
    sendJson(response, 200, await withScopedState(result, user.role));
    return true;
  }

  if (url.pathname === "/api/work-orders" && request.method === "POST") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager"])) return true;
    const body = await readJson(request);
    const result = await store.createWorkOrder({ ...body, operator: user.name });
    sendJson(response, 201, await withScopedState(result, user.role));
    return true;
  }

  const materialIssuesMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)\/material-issues$/);
  if (materialIssuesMatch && request.method === "GET") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager"])) return true;
    const workOrderId = decodeURIComponent(materialIssuesMatch[1]);
    const result = await store.getWorkOrderMaterialIssues(workOrderId);
    sendJson(response, 200, result);
    return true;
  }

  if (materialIssuesMatch && request.method === "POST") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager", "worker"])) return true;
    const body = await readJson(request);
    const workOrderId = decodeURIComponent(materialIssuesMatch[1]);
    try {
      const result = await store.createWorkOrderMaterialIssue(workOrderId, {
        ...body,
        operator: user.name,
        source: "work_order_issue",
      });
      sendJson(response, 201, await withScopedState(result, user.role));
    } catch (error) {
      if (isMaterialIssueBusinessError(error)) {
        sendJson(response, 400, { error: error.code || "INVALID_MATERIAL_ISSUE", message: error.message });
      } else {
        console.error("Work order material issue failed");
        sendJson(response, 500, { error: "SERVER_ERROR", message: "工单领料失败，请稍后重试" });
      }
    }
    return true;
  }

  if (url.pathname.startsWith("/api/work-orders/") && request.method === "PUT") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager"])) return true;
    const body = await readJson(request);
    const workOrderId = decodeURIComponent(url.pathname.slice("/api/work-orders/".length));
    const result = await store.updateWorkOrder(workOrderId, { ...body, operator: user.name });
    sendJson(response, 200, await withScopedState(result, user.role));
    return true;
  }

  if (url.pathname === "/api/material-items" && request.method === "GET") {
    const user = requireUser(request, response);
    if (!user) return true;
    const state = await store.getState(user.role);
    sendJson(response, 200, { materialItems: state.materialItems || [], materialSummaries: state.materialSummaries || [] });
    return true;
  }

  if (url.pathname === "/api/material-items" && request.method === "POST") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager"])) return true;
    const body = await readJson(request);
    const result = await store.createMaterialItem({ ...body, operator: user.name });
    sendJson(response, 201, await withScopedState(result, user.role));
    return true;
  }

  const fefoMatch = url.pathname.match(/^\/api\/material-items\/([^/]+)\/fefo$/);
  if (fefoMatch && request.method === "GET") {
    const user = requireUser(request, response);
    if (!user) return true;
    const materialCode = decodeURIComponent(fefoMatch[1]);
    const qty = Number(url.searchParams.get("qty") || 0);
    const includeExpired = url.searchParams.get("includeExpired") === "1";
    const recommendation = await store.getFefoRecommendation(materialCode, qty, { includeExpired });
    sendJson(response, 200, { recommendation });
    return true;
  }

  if (url.pathname === "/api/material-items/save" && request.method === "POST") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager"])) return true;
    const body = await readJson(request);
    const materialCode = String(body.code || "").trim();
    const state = await store.getState(user.role);
    const exists = (state.materialItems || []).some((item) => item.code === materialCode);
    const result = exists
      ? await store.updateMaterialItem(materialCode, { ...body, operator: user.name })
      : await store.createMaterialItem({ ...body, operator: user.name });
    sendJson(response, exists ? 200 : 201, await withScopedState(result, user.role));
    return true;
  }

  if (url.pathname.startsWith("/api/material-items/") && request.method === "PUT") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager"])) return true;
    const body = await readJson(request);
    const materialCode = decodeURIComponent(url.pathname.slice("/api/material-items/".length));
    const result = await store.updateMaterialItem(materialCode, { ...body, operator: user.name });
    sendJson(response, 200, await withScopedState(result, user.role));
    return true;
  }

  if (url.pathname === "/api/material-batches" && request.method === "GET") {
    const user = requireUser(request, response);
    if (!user) return true;
    const state = await store.getState(user.role);
    sendJson(response, 200, { materialBatches: state.materialBatches || [], materials: state.materials || [] });
    return true;
  }

  const materialBatchTraceMatch = url.pathname.match(/^\/api\/material-batches\/([^/]+)\/work-order-issues$/);
  if (materialBatchTraceMatch && request.method === "GET") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager"])) return true;
    let materialBatchId;
    try {
      materialBatchId = decodeURIComponent(materialBatchTraceMatch[1]).trim();
    } catch {
      sendJson(response, 400, { error: "INVALID_PARAMETER", message: "物料批次参数无效" });
      return true;
    }
    if (!materialBatchId || materialBatchId.includes("/") || materialBatchId.length > 200) {
      sendJson(response, 400, { error: "INVALID_PARAMETER", message: "物料批次参数无效" });
      return true;
    }
    try {
      const result = await store.getMaterialBatchWorkOrderIssues(materialBatchId);
      sendJson(response, 200, result);
    } catch (error) {
      if (error?.code === "INVALID_PARAMETER") {
        sendJson(response, 400, { error: "INVALID_PARAMETER", message: "物料批次参数无效" });
      } else if (error?.code === "NOT_FOUND") {
        sendJson(response, 404, { error: "NOT_FOUND", message: "物料批次不存在" });
      } else {
        console.error("Material batch trace query failed");
        sendJson(response, 500, { error: "SERVER_ERROR", message: "批次追溯查询失败" });
      }
    }
    return true;
  }

  if (url.pathname === "/api/material-batches" && request.method === "POST") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager"])) return true;
    const body = await readJson(request);
    const result = await store.createMaterialBatch({ ...body, operator: user.name });
    sendJson(response, 201, await withScopedState(result, user.role));
    return true;
  }

  if (url.pathname === "/api/reports" && request.method === "POST") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager", "worker", "warehouse"])) return true;
    const body = await readJson(request);
    const result = await store.createReport({ ...body, operator: user.name });
    sendJson(response, 201, await withScopedState(result, user.role));
    return true;
  }

  if (url.pathname === "/api/stock-movements" && request.method === "POST") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager", "worker", "warehouse"])) return true;
    const body = await readJson(request);
    const result = await store.createStockMovement({ ...body, operator: user.name });
    sendJson(response, 201, await withScopedState(result, user.role));
    return true;
  }

  const correctionMatch = url.pathname.match(/^\/api\/stock-movements\/([^/]+)\/correct$/);
  if (correctionMatch && request.method === "POST") {
    const user = requireUser(request, response);
    if (!user) return true;
    if (!requireRole(user, response, ["manager"])) return true;
    const body = await readJson(request);
    const movementId = decodeURIComponent(correctionMatch[1]);
    const result = await store.correctStockMovement(movementId, { ...body, operator: user.name });
    sendJson(response, 201, await withScopedState(result, user.role));
    return true;
  }

  return false;
}

async function serveStatic(request, response, url) {
  const requestPath = url.pathname === "/" ? "/admin.html" : url.pathname;
  const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    const type = mimeTypes[extname(filePath)] || "application/octet-stream";
    response.writeHead(200, { "content-type": type });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

async function serveQrScannerAsset(response, url) {
  const assetNames = {
    "/vendor/qr-scanner/qr-scanner.min.js": "qr-scanner.min.js",
    "/vendor/qr-scanner/qr-scanner-worker.min.js": "qr-scanner-worker.min.js",
  };
  const assetName = assetNames[url.pathname];
  if (!assetName) return false;

  try {
    const content = await readFile(join(qrScannerDir, assetName));
    response.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("QR scanner asset not found");
  }
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (await handleApi(request, response, url)) return;
    if (await serveQrScannerAsset(response, url)) return;
    await serveStatic(request, response, url);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "SERVER_ERROR", message: error.message });
  }
});

server.listen(port, () => {
  console.log(`Insole MES Alpha running on http://localhost:${port}`);
});
