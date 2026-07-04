import assert from "node:assert/strict";
import test from "node:test";
import {
  getDueDateRisk,
  getProcessProgressSummary,
  getRemainingReportableQty,
  getWorkOrderDerivedStatus,
  getWorkOrderQualitySummary,
  matchesWorkOrderFilter,
  validateReportPayload,
} from "../public/production-metrics.js";

const now = new Date(2026, 6, 4, 12, 0, 0);

test("due date risk covers unset, today, upcoming, overdue, and completed orders", () => {
  assert.equal(getDueDateRisk({ dueAt: "", status: "待开始" }, now).label, "未设置交期");
  assert.equal(getDueDateRisk({ dueAt: "2026-07-04", status: "生产中" }, now).label, "今日到期");
  assert.equal(getDueDateRisk({ dueAt: "2026-07-06", status: "生产中" }, now).key, "soon");
  assert.equal(getDueDateRisk({ dueAt: "2026-07-03", status: "生产中" }, now).label, "逾期 1 天");
  assert.equal(getDueDateRisk({ dueAt: "2026-07-03", status: "已完成" }, now).label, "已完成");
});

test("quality summary uses reports and supports legacy rows without completedQty", () => {
  const order = { id: "WO-1", plannedQty: 10 };
  const summary = getWorkOrderQualitySummary(order, [
    { workOrderId: "WO-1", completedQty: 4, goodQty: 3, badQty: 1 },
    { workOrderId: "WO-1", goodQty: 2, badQty: 0 },
    { workOrderId: "WO-2", completedQty: 9, goodQty: 9, badQty: 0 },
  ]);
  assert.equal(summary.completedQty, 6);
  assert.equal(summary.goodQty, 5);
  assert.equal(summary.badQty, 1);
  assert.equal(summary.badRate.toFixed(1), "16.7");
});

test("process progress and derived status use real route and report data", () => {
  const order = {
    id: "WO-RISK",
    plannedQty: 10,
    status: "生产中",
    priority: "高",
    dueAt: "2026-07-03",
    currentProcess: "成型",
    route: [
      { name: "备料", status: "已完成" },
      { name: "成型", status: "进行中" },
      { name: "检验", status: "待开始" },
    ],
  };
  const reports = [{ workOrderId: "WO-RISK", processName: "成型", completedQty: 2, goodQty: 1, badQty: 1 }];
  const progress = getProcessProgressSummary(order);
  assert.deepEqual({ completed: progress.completed, total: progress.total, currentIndex: progress.currentIndex }, { completed: 1, total: 3, currentIndex: 1 });

  const derived = getWorkOrderDerivedStatus(order, reports, [], now);
  assert.equal(derived.isInProgress, true);
  assert.equal(derived.isUrgent, true);
  assert.equal(derived.isOverdue, true);
  assert.equal(derived.hasRisk, true);
});

test("report validation blocks over-reporting and missing bad reason", () => {
  const order = { id: "WO-1", plannedQty: 10 };
  const reports = [{ workOrderId: "WO-1", processName: "备料", completedQty: 8, goodQty: 8, badQty: 0 }];
  const remaining = getRemainingReportableQty(order, "备料", reports);
  assert.equal(remaining, 2);
  assert.match(validateReportPayload({ completedQty: 3, goodQty: 3, badQty: 0, badReason: "" }, remaining), /最多可报 2/);
  assert.match(validateReportPayload({ completedQty: 2, goodQty: 1, badQty: 1, badReason: "" }, remaining), /必须填写不良原因/);
  assert.equal(validateReportPayload({ completedQty: 2, goodQty: 1, badQty: 1, badReason: "压制偏差" }, remaining), "");
});

test("empty route has a stable fallback summary", () => {
  assert.deepEqual(getProcessProgressSummary({ route: [] }), {
    route: [],
    completed: 0,
    total: 0,
    percent: 0,
    currentIndex: -1,
  });
});

test("production filters return consistent counts from the same derived rules", () => {
  const orders = [
    { id: "A", status: "待开始", priority: "中", dueAt: "", route: [] },
    { id: "B", status: "生产中", priority: "高", dueAt: "2026-07-03", route: [] },
    { id: "C", status: "已完成", priority: "低", dueAt: "2026-07-02", route: [] },
    { id: "D", status: "生产中", priority: "中", dueAt: "2026-07-06", route: [] },
  ];
  const count = (filterKey) => orders.filter((order) => matchesWorkOrderFilter(order, filterKey, [], [], now)).length;
  assert.equal(count("all"), 4);
  assert.equal(count("not-started"), 1);
  assert.equal(count("in-progress"), 2);
  assert.equal(count("completed"), 1);
  assert.equal(count("urgent"), 1);
  assert.equal(count("overdue"), 1);
  assert.equal(count("due-soon"), 1);
  assert.equal(count("risk"), 1);
});
