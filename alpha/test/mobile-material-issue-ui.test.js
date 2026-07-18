import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile material issue uses one multi-step sheet and a fourth quick action", async () => {
  const [html, css, script] = await Promise.all([
    readFile(new URL("../public/mobile.html", import.meta.url), "utf8"),
    readFile(new URL("../public/mobile.css", import.meta.url), "utf8"),
    readFile(new URL("../public/mobile.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="action-material-issue"[^>]*>工单领料/);
  assert.equal((html.match(/id="material-issue-section"/g) || []).length, 1);
  for (const step of ["workorder", "batch", "input", "confirm", "result"]) {
    assert.match(html, new RegExp(`id="material-issue-${step}-step"`));
  }
  assert.match(html, /id="issue-qty"[^>]*step="any"[^>]*inputmode="decimal"/);
  const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "mobile page must not contain duplicate element ids");
  assert.match(css, /\.quick-actions\s*\{[\s\S]*grid-template-columns:\s*repeat\(2/);
  assert.match(css, /min-height:\s*48px/);
  assert.match(script, /issueWorkOrder/);
  assert.match(script, /issueBatch/);
  assert.match(script, /materialIssueSubmitUnknown/);
  assert.doesNotMatch(script, /if \(result\.user\.role === "manager"\)\s*\{\s*handoffToAdmin/);
});

test("PostgreSQL material issue transaction locks and validates before atomic writes", async () => {
  const source = await readFile(new URL("../src/store.js", import.meta.url), "utf8");
  const start = source.lastIndexOf("async createWorkOrderMaterialIssue(workOrderId, input)");
  const end = source.indexOf("async createStockMovement(input)", start);
  const transaction = source.slice(start, end);
  const begin = transaction.indexOf('client.query("begin")');
  const orderLock = transaction.indexOf("from work_orders where id=$1 for update");
  const batchLock = transaction.indexOf("from material_batches where material_code=$1 and batch_no=$2 for update");
  const inventoryCheck = transaction.indexOf("assertStockMovementInput");
  const inventoryUpdate = transaction.indexOf("update material_batches set stock_qty");
  const movementInsert = transaction.indexOf("insert into stock_movements");
  const issueInsert = transaction.indexOf("insert into work_order_material_issues");
  const activityInsert = transaction.indexOf("insert into activities");
  const commit = transaction.indexOf('client.query("commit")');
  const rollback = transaction.indexOf('client.query("rollback")');
  assert.ok(begin >= 0);
  assert.ok(begin < orderLock && orderLock < batchLock);
  assert.ok(batchLock < inventoryCheck && inventoryCheck < inventoryUpdate);
  assert.ok(inventoryUpdate < movementInsert && movementInsert < issueInsert && issueInsert < activityInsert);
  assert.ok(activityInsert < commit);
  assert.ok(rollback > commit);
});
