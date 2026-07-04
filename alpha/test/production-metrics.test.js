import assert from "node:assert/strict";
import test from "node:test";
import {
  getDueDateRisk,
  getProcessInputContext,
  getProcessProgressSummary,
  getRemainingReportableQty,
  getWorkOrderDerivedStatus,
  getWorkOrderFlowSummary,
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
  const order = {
    id: "WO-1",
    plannedQty: 10,
    status: "生产中",
    currentProcess: "B",
    route: [
      { name: "A", status: "已完成" },
      { name: "B", status: "进行中" },
    ],
  };
  const summary = getWorkOrderQualitySummary(order, [
    { workOrderId: "WO-1", processName: "A", completedQty: 4, goodQty: 3, badQty: 1 },
    { workOrderId: "WO-1", processName: "B", goodQty: 2, badQty: 0 },
    { workOrderId: "WO-2", completedQty: 9, goodQty: 9, badQty: 0 },
  ]);
  assert.equal(summary.completedQty, 6);
  assert.equal(summary.currentTransferableGoodQty, 2);
  assert.equal(summary.finishedGoodQty, 0);
  assert.equal(summary.cumulativeGoodQty, 5);
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
  const order = { id: "WO-1", plannedQty: 10, route: [{ name: "备料", status: "进行中" }] };
  const reports = [{ workOrderId: "WO-1", processName: "备料", completedQty: 8, goodQty: 8, badQty: 0 }];
  const remaining = getRemainingReportableQty(order, "备料", reports);
  assert.equal(remaining, 2);
  assert.match(validateReportPayload({ completedQty: -1, goodQty: -1, badQty: 0, badReason: "" }, remaining), /大于或等于 0 的整数/);
  assert.match(validateReportPayload({ completedQty: 1.5, goodQty: 1.5, badQty: 0, badReason: "" }, remaining), /大于或等于 0 的整数/);
  assert.match(validateReportPayload({ completedQty: 3, goodQty: 3, badQty: 0, badReason: "" }, remaining), /最多还可报 2/);
  assert.match(validateReportPayload({ completedQty: 2, goodQty: 1, badQty: 0, badReason: "" }, remaining), /必须等于/);
  assert.match(validateReportPayload({ completedQty: 2, goodQty: 1, badQty: 1, badReason: "" }, remaining), /必须填写不良原因/);
  assert.equal(validateReportPayload({ completedQty: 2, goodQty: 1, badQty: 1, badReason: "压制偏差" }, remaining), "");
});

test("process input limit comes from previous process good quantity", () => {
  const order = {
    id: "WO-FLOW",
    plannedQty: 10,
    status: "生产中",
    currentProcess: "B",
    route: [
      { name: "A", status: "已完成" },
      { name: "B", status: "进行中" },
      { name: "C", status: "待开始" },
    ],
  };
  const reports = [
    { workOrderId: "WO-FLOW", processName: "A", completedQty: 10, goodQty: 9, badQty: 1 },
    { workOrderId: "WO-FLOW", processName: "B", completedQty: 4, goodQty: 4, badQty: 0 },
  ];

  const firstContext = getProcessInputContext(order, "A", reports);
  const secondContext = getProcessInputContext(order, "B", reports);
  assert.equal(firstContext.inputLimit, 10);
  assert.equal(secondContext.previousGoodQty, 9);
  assert.equal(secondContext.inputLimit, 9);
  assert.equal(getRemainingReportableQty(order, "B", reports), 5);
});

test("management flow metrics never present cross-process good sum as finished good", () => {
  const order = {
    id: "WO-METRICS",
    plannedQty: 10,
    doneQty: 8,
    status: "已完成",
    currentProcess: "C",
    route: [
      { name: "A", status: "已完成" },
      { name: "B", status: "已完成" },
      { name: "C", status: "已完成" },
    ],
  };
  const reports = [
    { workOrderId: "WO-METRICS", processName: "A", completedQty: 10, goodQty: 9, badQty: 1 },
    { workOrderId: "WO-METRICS", processName: "B", completedQty: 9, goodQty: 8, badQty: 1 },
    { workOrderId: "WO-METRICS", processName: "C", completedQty: 8, goodQty: 8, badQty: 0 },
  ];
  const flow = getWorkOrderFlowSummary(order, reports);
  const quality = getWorkOrderQualitySummary(order, reports);

  assert.equal(flow.cumulativeProcessedQty, 27);
  assert.equal(flow.cumulativeGoodQty, 25);
  assert.equal(flow.currentTransferableGoodQty, 8);
  assert.equal(flow.finishedGoodQty, 8);
  assert.equal(flow.cumulativeBadQty, 2);
  assert.equal(flow.hasFinalShortage, true);
  assert.equal(flow.shortageQty, 2);
  assert.equal(flow.processBadRate.toFixed(1), "7.4");
  assert.equal(quality.goodQty, 8);
  assert.equal(quality.completedQty, 27);
  assert.equal(getWorkOrderDerivedStatus(order, reports, [], now).hasRisk, true);
  assert.ok(flow.finishedGoodQty <= order.plannedQty);
  assert.ok(flow.currentTransferableGoodQty <= order.plannedQty);
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
