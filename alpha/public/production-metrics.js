const DUE_SOON_DAYS = 3;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export function getReportCompletedQty(report) {
  const completedQty = Number(report?.completedQty);
  return Number.isFinite(completedQty) && completedQty > 0
    ? completedQty
    : Number(report?.goodQty || 0) + Number(report?.badQty || 0);
}

export function getWorkOrderQualitySummary(order, reports = []) {
  const orderReports = reports.filter((report) => report.workOrderId === order.id);
  const completedQty = orderReports.reduce((sum, report) => sum + getReportCompletedQty(report), 0);
  const goodQty = orderReports.reduce((sum, report) => sum + Number(report.goodQty || 0), 0);
  const badQty = orderReports.reduce((sum, report) => sum + Number(report.badQty || 0), 0);
  return {
    reports: orderReports,
    completedQty,
    goodQty,
    badQty,
    badRate: Number(order.plannedQty || 0) > 0 && completedQty > 0 ? (badQty / completedQty) * 100 : null,
  };
}

export function parseDueDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getDueDateRisk(order, now = new Date()) {
  const dueDate = parseDueDate(order.dueAt);
  if (!dueDate) return { key: "unset", label: "未设置交期", days: null };
  if (order.status === "已完成") return { key: "completed", label: "已完成", days: null };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayDifference = Math.round((dueDate.getTime() - today.getTime()) / MILLISECONDS_PER_DAY);
  if (dayDifference < 0) return { key: "overdue", label: `逾期 ${Math.abs(dayDifference)} 天`, days: dayDifference };
  if (dayDifference === 0) return { key: "today", label: "今日到期", days: 0 };
  if (dayDifference <= DUE_SOON_DAYS) return { key: "soon", label: `剩余 ${dayDifference} 天`, days: dayDifference };
  return { key: "normal", label: `剩余 ${dayDifference} 天`, days: dayDifference };
}

export function getProcessProgressSummary(order) {
  const route = Array.isArray(order.route) ? order.route.filter((step) => step?.name) : [];
  if (!route.length) return { route: [], completed: 0, total: 0, percent: 0, currentIndex: -1 };
  const completed = route.filter((step) => step.status === "已完成").length;
  const currentIndex = route.findIndex((step) => step.name === order.currentProcess);
  return {
    route,
    completed,
    total: route.length,
    percent: Math.round((completed / route.length) * 100),
    currentIndex,
  };
}

export function getProcessReportedQty(orderId, processName, reports = []) {
  return reports
    .filter((report) => report.workOrderId === orderId && report.processName === processName)
    .reduce((sum, report) => sum + getReportCompletedQty(report), 0);
}

export function getRemainingReportableQty(order, processName, reports = []) {
  if (!order) return 0;
  return Math.max(0, Number(order.plannedQty || 0) - getProcessReportedQty(order.id, processName, reports));
}

export function validateReportPayload(payload, remainingQty) {
  const quantities = [payload.completedQty, payload.goodQty, payload.badQty];
  if (!quantities.every((value) => Number.isFinite(value) && Number.isInteger(value) && value >= 0)) {
    return "数量必须是大于或等于 0 的整数";
  }
  if (payload.completedQty <= 0) return "本次完成数量必须大于 0";
  if (payload.completedQty > remainingQty) return `本次最多可报 ${remainingQty}`;
  if (payload.goodQty + payload.badQty > payload.completedQty) return "良品数与不良数之和不能大于完成数量";
  if (payload.badQty > 0 && !payload.badReason) return "有不良品时必须填写不良原因";
  return "";
}

export function getWorkOrderDerivedStatus(order, reports = [], alerts = [], now = new Date()) {
  const dueRisk = getDueDateRisk(order, now);
  const quality = getWorkOrderQualitySummary(order, reports);
  const hasOrderAlert = alerts.some(
    (alert) => alert.status === "open" && `${alert.title || ""} ${alert.text || ""}`.includes(order.id)
  );
  const isCompleted = order.status === "已完成";
  const isNotStarted = ["待领料", "待开始", "草稿", "待下发"].includes(order.status);
  const isInProgress = ["生产中", "进行中", "已暂停", "暂停"].includes(order.status);
  const isUrgent = ["高", "加急"].includes(order.priority);
  const isOverdue = dueRisk.key === "overdue";
  const isDueSoon = dueRisk.key === "soon";
  const hasRisk = isOverdue || quality.badQty > 0 || hasOrderAlert || ["已暂停", "暂停"].includes(order.status);
  return { isCompleted, isNotStarted, isInProgress, isUrgent, isOverdue, isDueSoon, hasRisk, dueRisk, quality };
}

export function matchesWorkOrderFilter(order, filterKey, reports = [], alerts = [], now = new Date()) {
  const derived = getWorkOrderDerivedStatus(order, reports, alerts, now);
  const matchers = {
    all: true,
    "not-started": derived.isNotStarted,
    "in-progress": derived.isInProgress,
    completed: derived.isCompleted,
    urgent: derived.isUrgent,
    overdue: derived.isOverdue,
    "due-soon": derived.isDueSoon,
    risk: derived.hasRisk,
  };
  return Boolean(matchers[filterKey]);
}
