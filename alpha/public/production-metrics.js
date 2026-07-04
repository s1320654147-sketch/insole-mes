const DUE_SOON_DAYS = 3;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export function getReportCompletedQty(report) {
  const completedQty = Number(report?.completedQty);
  return Number.isFinite(completedQty) && completedQty > 0
    ? completedQty
    : Number(report?.goodQty || 0) + Number(report?.badQty || 0);
}

function getOrderRoute(order) {
  return Array.isArray(order?.route) ? order.route.filter((step) => step?.name) : [];
}

function clampToPlan(value, plannedQty) {
  return Math.max(0, Math.min(Number(plannedQty || 0), Number(value || 0)));
}

export function getProcessReportSummary(orderId, processName, reports = []) {
  const processReports = reports.filter(
    (report) => report.workOrderId === orderId && report.processName === processName
  );
  return {
    reports: processReports,
    reportCount: processReports.length,
    processedQty: processReports.reduce((sum, report) => sum + getReportCompletedQty(report), 0),
    goodQty: processReports.reduce((sum, report) => sum + Number(report.goodQty || 0), 0),
    badQty: processReports.reduce((sum, report) => sum + Number(report.badQty || 0), 0),
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
  const route = getOrderRoute(order);
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
  return getProcessReportSummary(orderId, processName, reports).processedQty;
}

export function getProcessInputContext(order, processName, reports = []) {
  const plannedQty = Number(order?.plannedQty || 0);
  const route = getOrderRoute(order);
  if (!order || !processName) {
    return {
      inputLimit: 0,
      isFirst: false,
      previousProcessName: "",
      previousGoodQty: 0,
      source: "blocked",
    };
  }

  if (!route.length) {
    return {
      inputLimit: plannedQty,
      isFirst: true,
      previousProcessName: "",
      previousGoodQty: 0,
      source: "planned",
    };
  }

  const processIndex = route.findIndex((step) => step.name === processName);
  if (processIndex < 0) {
    return {
      inputLimit: 0,
      isFirst: false,
      previousProcessName: "",
      previousGoodQty: 0,
      source: "blocked",
    };
  }

  if (processIndex === 0) {
    return {
      inputLimit: plannedQty,
      isFirst: true,
      previousProcessName: "",
      previousGoodQty: 0,
      source: "planned",
    };
  }

  const previousStep = route[processIndex - 1];
  const previousSummary = getProcessReportSummary(order.id, previousStep.name, reports);
  if (previousSummary.reportCount > 0) {
    const previousGoodQty = clampToPlan(previousSummary.goodQty, plannedQty);
    return {
      inputLimit: previousGoodQty,
      isFirst: false,
      previousProcessName: previousStep.name,
      previousGoodQty,
      source: "reported-good",
    };
  }

  if (previousStep.status === "已完成") {
    return {
      inputLimit: plannedQty,
      isFirst: false,
      previousProcessName: previousStep.name,
      previousGoodQty: plannedQty,
      source: "legacy-route",
    };
  }

  return {
    inputLimit: 0,
    isFirst: false,
    previousProcessName: previousStep.name,
    previousGoodQty: 0,
    source: "blocked",
  };
}

export function getProcessInputLimit(order, processName, reports = []) {
  return getProcessInputContext(order, processName, reports).inputLimit;
}

export function getRemainingReportableQty(order, processName, reports = []) {
  if (!order) return 0;
  const inputLimit = getProcessInputLimit(order, processName, reports);
  return Math.max(0, inputLimit - getProcessReportedQty(order.id, processName, reports));
}

export function validateReportPayload(payload, remainingQty) {
  const quantities = [payload.completedQty, payload.goodQty, payload.badQty];
  if (!quantities.every((value) => Number.isFinite(value) && Number.isInteger(value) && value >= 0)) {
    return "数量必须是大于或等于 0 的整数";
  }
  if (payload.completedQty <= 0) return "本次完成数量必须大于 0";
  if (payload.badQty > payload.completedQty) return "不良数量不能大于本次完成数量";
  if (payload.completedQty !== payload.goodQty + payload.badQty) return "本次完成数量必须等于良品数与不良数之和";
  if (payload.completedQty > remainingQty) return `本工序最多还可报 ${remainingQty}，不能报 ${payload.completedQty}`;
  if (payload.badQty > 0 && !payload.badReason) return "有不良品时必须填写不良原因";
  return "";
}

export function getWorkOrderFlowSummary(order, reports = []) {
  const plannedQty = Number(order?.plannedQty || 0);
  const route = getOrderRoute(order);
  const orderReports = reports.filter((report) => report.workOrderId === order?.id);
  const stageSummaries = route.map((step) => {
    const reportSummary = getProcessReportSummary(order.id, step.name, orderReports);
    const inputContext = getProcessInputContext(order, step.name, orderReports);
    return {
      name: step.name,
      status: step.status || "待开始",
      ...reportSummary,
      ...inputContext,
      remainingQty: Math.max(0, inputContext.inputLimit - reportSummary.processedQty),
    };
  });
  const cumulativeProcessedQty = orderReports.reduce((sum, report) => sum + getReportCompletedQty(report), 0);
  const cumulativeGoodQty = orderReports.reduce((sum, report) => sum + Number(report.goodQty || 0), 0);
  const cumulativeBadQty = orderReports.reduce((sum, report) => sum + Number(report.badQty || 0), 0);
  const latestReportedStage = [...stageSummaries].reverse().find((stage) => stage.reportCount > 0) || null;
  const finalStage = stageSummaries[stageSummaries.length - 1] || null;
  const legacyGoodQty = clampToPlan(order?.doneQty, plannedQty);
  const currentTransferableGoodQty = latestReportedStage
    ? clampToPlan(latestReportedStage.goodQty, plannedQty)
    : legacyGoodQty;
  const finalStageCompleted = finalStage?.status === "已完成" || order?.status === "已完成";
  const finishedGoodQty = finalStage?.reportCount && finalStageCompleted
    ? clampToPlan(finalStage.goodQty, plannedQty)
    : order?.status === "已完成"
      ? legacyGoodQty
      : 0;
  const hasFinalShortage = order?.status === "已完成" && finishedGoodQty < plannedQty;

  return {
    reports: orderReports,
    stageSummaries,
    cumulativeProcessedQty,
    cumulativeGoodQty,
    cumulativeBadQty,
    currentTransferableGoodQty,
    finishedGoodQty,
    hasFinalShortage,
    shortageQty: hasFinalShortage ? plannedQty - finishedGoodQty : 0,
    processBadRate: cumulativeProcessedQty > 0 ? (cumulativeBadQty / cumulativeProcessedQty) * 100 : null,
    finalStage,
    latestReportedStage,
  };
}

export function getWorkOrderQualitySummary(order, reports = []) {
  const flow = getWorkOrderFlowSummary(order, reports);
  return {
    ...flow,
    completedQty: flow.cumulativeProcessedQty,
    goodQty: flow.finishedGoodQty,
    badQty: flow.cumulativeBadQty,
    badRate: flow.processBadRate,
  };
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
  const hasRisk =
    isOverdue ||
    quality.badQty > 0 ||
    quality.hasFinalShortage ||
    hasOrderAlert ||
    ["已暂停", "暂停"].includes(order.status);
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
