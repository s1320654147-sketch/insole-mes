import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getProcessInputContext,
  getProcessReportSummary,
} from "../public/production-metrics.js";
import { seedData } from "./seed.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function decimalParts(value) {
  const text = String(value ?? 0).trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match || !Number.isFinite(Number(text))) return { integer: 0n, scale: 0 };
  let digits = `${match[2]}${match[3] || ""}`.replace(/^0+(?=\d)/, "") || "0";
  let scale = (match[3] || "").length - Number(match[4] || 0);
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  return {
    integer: BigInt(`${match[1] === "-" ? "-" : ""}${digits}`),
    scale,
  };
}

export function sumDecimalQuantities(values = []) {
  const parts = values.map(decimalParts);
  const scale = parts.reduce((max, item) => Math.max(max, item.scale), 0);
  const total = parts.reduce(
    (sum, item) => sum + item.integer * 10n ** BigInt(scale - item.scale),
    0n
  );
  if (total === 0n) return 0;
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const raw = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return Number(`${negative ? "-" : ""}${raw}`);
}

function addDecimalQuantities(left, right) {
  return sumDecimalQuantities([left, right]);
}

export const workOrderMaterialIssueAllowedStatuses = Object.freeze([
  "待领料",
  "待开始",
  "生产中",
]);

export function assertWorkOrderMaterialIssueStatus(order = {}) {
  const status = String(order.status || "").trim();
  if (!workOrderMaterialIssueAllowedStatuses.includes(status)) {
    throw createStoreError("WORK_ORDER_STATUS_NOT_ALLOWED", `当前工单状态不允许领料：${status || "未知状态"}`);
  }
}

function requireMaterialBatchId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 200 || id.includes("/")) {
    throw createStoreError("INVALID_PARAMETER", "物料批次参数无效");
  }
  return id;
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function makeBusinessId(prefix, existingIds = []) {
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  let seq = 1;
  let nextId = `${prefix}-${date}-${String(seq).padStart(2, "0")}`;
  const used = new Set(existingIds);
  while (used.has(nextId)) {
    seq += 1;
    nextId = `${prefix}-${date}-${String(seq).padStart(2, "0")}`;
  }
  return nextId;
}

function defaultRoute() {
  return [
    { name: "备料", status: "待开始" },
    { name: "裁切 / 开料", status: "待开始" },
    { name: "成型 / 压制", status: "待开始" },
    { name: "修边", status: "待开始" },
    { name: "检验", status: "待开始" },
    { name: "包装 / 入库", status: "待开始" },
  ];
}

function normalizeRoute(routeInput) {
  const source = Array.isArray(routeInput) ? routeInput : [];
  const route = source
    .map((step) => ({
      name: String(step?.name || "").trim(),
      status: String(step?.status || "待开始").trim() || "待开始",
    }))
    .filter((step) => step.name);
  return route.length ? route : defaultRoute();
}

function normalizeSampleInput(input, fallback = {}) {
  return {
    name: String(input.name || fallback.name || "").trim(),
    customer: String(input.customer || fallback.customer || "").trim(),
    version: String(input.version || fallback.version || "").trim(),
    owner: String(input.owner || fallback.owner || "").trim(),
    dueDate: String(input.dueDate || fallback.dueDate || "").trim(),
    status: String(input.status || fallback.status || "待打样").trim() || "待打样",
  };
}

function normalizeOrderInput(input, fallback = {}) {
  const route = normalizeRoute(input.route ?? fallback.route);
  const currentProcess = String(input.currentProcess || fallback.currentProcess || route[0]?.name || "待领料").trim();
  return {
    sampleId: String(input.sampleId || fallback.sampleId || "").trim(),
    product: String(input.product || fallback.product || "").trim(),
    plannedQty: Number(input.plannedQty ?? fallback.plannedQty ?? 0),
    doneQty: Number(input.doneQty ?? fallback.doneQty ?? 0),
    currentProcess,
    priority: String(input.priority || fallback.priority || "中").trim() || "中",
    status: String(input.status || fallback.status || "待领料").trim() || "待领料",
    dueAt: String(input.dueAt || fallback.dueAt || "").trim(),
    route,
  };
}

function assertSampleInput(sample) {
  if (!sample.name) throw new Error("样品名称不能为空");
  if (!sample.owner) throw new Error("负责人不能为空");
  if (!sample.dueDate) throw new Error("样品截止日期不能为空");
}

function assertOrderInput(order) {
  if (!order.product) throw new Error("产品名称不能为空");
  if (!Number.isFinite(order.plannedQty) || order.plannedQty <= 0) throw new Error("计划数量必须大于 0");
  if (!order.currentProcess) throw new Error("当前工序不能为空");
  if (!order.route.length) throw new Error("至少需要 1 个工序");
}

function normalizeReportInput(input, order) {
  const goodQty = Number(input.goodQty ?? 0);
  const badQty = Number(input.badQty ?? 0);
  const fallbackCompleted = goodQty + badQty;
  return {
    workOrderId: String(input.workOrderId || "").trim(),
    processName: String(input.processName || order?.currentProcess || "").trim(),
    completedQty: Number(input.completedQty ?? fallbackCompleted),
    goodQty,
    badQty,
    badReason: String(input.badReason || "").trim(),
    note: String(input.note || "").trim(),
    operator: String(input.operator || "").trim(),
  };
}

function assertReportInput(report, order, existingReports = []) {
  const quantities = [report.completedQty, report.goodQty, report.badQty];
  if (!quantities.every((value) => Number.isFinite(value) && Number.isInteger(value) && value >= 0)) {
    throw new Error("报工数量必须是大于或等于 0 的整数");
  }
  if (report.completedQty <= 0) throw new Error("完成数量必须大于 0");
  if (report.badQty > report.completedQty) throw new Error("不良数量不能大于本次完成数量");
  if (!report.processName) throw new Error("请选择当前工序");
  if (Array.isArray(order.route) && order.route.length && !order.route.some((step) => step.name === report.processName)) {
    throw new Error("所选工序不在当前工艺路线中");
  }
  if (report.completedQty !== report.goodQty + report.badQty) {
    throw new Error("本次完成数量必须等于良品数与不良数之和");
  }
  const inputContext = getProcessInputContext(order, report.processName, existingReports);
  const processedQty = getProcessReportSummary(order.id, report.processName, existingReports).processedQty;
  const remainingQty = Math.max(0, inputContext.inputLimit - processedQty);
  if (report.completedQty > remainingQty) {
    const upstreamNote =
      !inputContext.isFirst && inputContext.source === "reported-good"
        ? `上一工序良品数为 ${inputContext.previousGoodQty}，`
        : "";
    throw new Error(`${upstreamNote}本工序最多还可报 ${remainingQty}，不能报 ${report.completedQty}`);
  }
  if (report.badQty > 0 && !report.badReason) throw new Error("有不良品时必须填写不良原因");
}

function applyReportProgress(order, existingReports, report) {
  const allReports = [report, ...existingReports];
  const route = normalizeRoute(order.route).map((step) => ({ ...step }));
  const processIndex = route.findIndex((step) => step.name === report.processName);

  order.status = "生产中";

  if (processIndex < 0) return;

  const processSummary = getProcessReportSummary(order.id, report.processName, allReports);
  const inputContext = getProcessInputContext({ ...order, route }, report.processName, allReports);
  const processFinished = inputContext.inputLimit > 0 && processSummary.processedQty >= inputContext.inputLimit;
  route[processIndex].status = processFinished ? "已完成" : "进行中";

  if (processFinished) {
    const nextStep = route[processIndex + 1];
    if (nextStep) {
      if (nextStep.status !== "已完成") nextStep.status = "进行中";
      order.currentProcess = nextStep.name;
    } else {
      order.currentProcess = route[processIndex].name;
      order.status = "已完成";
    }
  } else {
    order.currentProcess = route[processIndex].name;
  }

  order.route = route;
  const finalStep = route[route.length - 1];
  const finalSummary = finalStep ? getProcessReportSummary(order.id, finalStep.name, allReports) : null;
  order.doneQty =
    finalStep?.status === "已完成"
      ? Math.min(Number(order.plannedQty || 0), Number(finalSummary?.goodQty || 0))
      : 0;
}

function normalizeStockMovementInput(input, fallback = {}) {
  return {
    materialCode: String(input.materialCode || fallback.materialCode || "").trim(),
    batchNo: String(input.batchNo || fallback.batchNo || "").trim(),
    type: input.type === "out" ? "out" : "in",
    qty: Number(input.qty ?? fallback.qty ?? 0),
    location: String(input.location || fallback.location || "").trim(),
    note: String(input.note || fallback.note || "").trim(),
    overrideReason: String(input.overrideReason || input.forceReason || fallback.overrideReason || fallback.forceReason || "").trim(),
    correctionReason: String(input.correctionReason || fallback.correctionReason || "").trim(),
  };
}

function normalizeWorkOrderMaterialIssueInput(workOrderId, input = {}) {
  const movement = normalizeStockMovementInput({ ...input, type: "out" });
  return {
    workOrderId: String(workOrderId || "").trim(),
    materialCode: movement.materialCode,
    batchNo: movement.batchNo,
    qty: movement.qty,
    location: movement.location,
    note: movement.note,
    overrideReason: movement.overrideReason,
    operator: String(input.operator || "").trim(),
  };
}

function normalizeWorkOrderMaterialIssueRecord(input = {}) {
  return {
    id: String(input.id || "").trim(),
    workOrderId: String(input.workOrderId || "").trim(),
    materialCode: String(input.materialCode || "").trim(),
    materialName: String(input.materialName || "").trim(),
    materialBatchId: String(input.materialBatchId || "").trim(),
    batchNo: String(input.batchNo || "").trim(),
    qty: Number(input.qty || 0),
    unit: String(input.unit || "").trim(),
    location: String(input.location || "").trim(),
    operator: String(input.operator || "").trim(),
    source: String(input.source || "work_order_issue").trim() || "work_order_issue",
    recommendedBatchNo: String(input.recommendedBatchNo || "").trim(),
    isFefoRecommended: input.isFefoRecommended === true || input.isFefoRecommended === "true",
    overrideReason: String(input.overrideReason || "").trim(),
    stockMovementId: String(input.stockMovementId || "").trim(),
    isCorrected: input.isCorrected === true || input.isCorrected === "true",
    correctionMovementId: String(input.correctionMovementId || "").trim(),
    correctionReason: String(input.correctionReason || "").trim(),
    correctedAt: input.correctedAt || "",
    createdAt: input.createdAt || "",
    note: String(input.note || "").trim(),
  };
}

function assertStockMovementInput(movement, availableQty = Number.POSITIVE_INFINITY) {
  if (!movement.materialCode) throw new Error("物料料号不能为空");
  if (!movement.batchNo) throw new Error("物料批次不能为空");
  if (!Number.isFinite(movement.qty) || movement.qty <= 0) throw new Error("出入库数量必须大于 0");
  if (movement.type === "out" && movement.qty > Number(availableQty || 0)) {
    throw new Error("出库数量不能大于当前库存");
  }
}

function buildWorkOrderMaterialIssue({ order, material, batch, movement, fefoPlan, input }) {
  const recommendedBatchNo = fefoPlan?.recommendedBatch?.batchNo || "";
  const isExpired = getBatchExpiryStatus(batch) === "已过期";
  return {
    id: makeId("woi"),
    workOrderId: order.id,
    materialCode: batch.materialCode,
    materialName: material.name || batch.materialCode,
    materialBatchId: batch.id || movement.materialBatchId || "",
    batchNo: batch.batchNo,
    qty: movement.qty,
    unit: materialUnitLabel(material),
    location: movement.location || batch.location || "",
    operator: input.operator,
    source: "work_order_issue",
    recommendedBatchNo,
    isFefoRecommended: Boolean(recommendedBatchNo) && recommendedBatchNo === batch.batchNo && !isExpired,
    overrideReason: input.overrideReason || "",
    stockMovementId: movement.id,
    createdAt: movement.createdAt,
    note: input.note || "",
  };
}

function enrichWorkOrderMaterialIssues(issues = [], stockMovements = []) {
  const movementsById = new Map(stockMovements.map((item) => [item.id, item]));
  return issues.map((rawIssue) => {
    const issue = normalizeWorkOrderMaterialIssueRecord(rawIssue);
    const movement = movementsById.get(issue.stockMovementId);
    const correction = movement?.correctedByMovementId ? movementsById.get(movement.correctedByMovementId) : null;
    const correctionMovementId = movement?.correctedByMovementId || issue.correctionMovementId || "";
    const correctionReason = movement?.correctionReason || correction?.correctionReason || issue.correctionReason || "";
    const correctedAt = movement?.correctedAt || correction?.createdAt || issue.correctedAt || "";
    const isCorrected = Boolean(correctionMovementId || issue.isCorrected);
    return {
      ...issue,
      isCorrected,
      status: isCorrected ? "已冲正" : "已领料",
      netQty: isCorrected ? 0 : Number(issue.qty || 0),
      correctionMovementId,
      correctionReason,
      correctedAt,
    };
  });
}

function toOptionalNumber(value) {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function normalizeTraceMovement(input = {}) {
  const id = String(input.id || "").trim();
  if (!id) return null;
  return {
    id,
    materialCode: String(input.materialCode || "").trim(),
    batchNo: String(input.batchNo || "").trim(),
    type: String(input.type || "").trim(),
    qty: Number(input.qty || 0),
    location: String(input.location || "").trim(),
    note: String(input.note || "").trim(),
    operator: String(input.operator || "").trim(),
    source: String(input.source || "").trim(),
    beforeQty: toOptionalNumber(input.beforeQty),
    afterQty: toOptionalNumber(input.afterQty),
    materialBatchId: String(input.materialBatchId || "").trim(),
    correctionOfMovementId: String(input.correctionOfMovementId || "").trim(),
    correctedByMovementId: String(input.correctedByMovementId || "").trim(),
    correctionReason: String(input.correctionReason || "").trim(),
    correctedAt: input.correctedAt || "",
    createdAt: input.createdAt || "",
  };
}

function normalizeTraceWorkOrder(input = {}) {
  const id = String(input.id || "").trim();
  if (!id) return null;
  return {
    id,
    product: String(input.product || "").trim(),
    status: String(input.status || "").trim(),
    currentProcess: String(input.currentProcess || "").trim(),
    plannedQty: toOptionalNumber(input.plannedQty),
    doneQty: toOptionalNumber(input.doneQty),
    priority: String(input.priority || "").trim(),
    dueAt: input.dueAt || "",
    route: input.route || [],
  };
}

function traceDateRank(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function compareTraceDates(left, right) {
  const leftRank = traceDateRank(left);
  const rightRank = traceDateRank(right);
  if (leftRank !== rightRank) return rightRank - leftRank;
  return String(right || "").localeCompare(String(left || ""));
}

function traceStatusLabel(status) {
  if (status === "active") return "当前有效";
  if (status === "corrected") return "已冲正";
  return "状态待核验";
}

function normalizeTraceIssue(rawIssue = {}, batch, movementsById, workOrdersById) {
  const issue = normalizeWorkOrderMaterialIssueRecord(rawIssue);
  const movementCandidate = rawIssue.stockMovement?.id ? rawIssue.stockMovement : movementsById.get(issue.stockMovementId);
  const originalMovement = normalizeTraceMovement(movementCandidate);
  const correctionMovementId = originalMovement?.correctedByMovementId || issue.correctionMovementId || "";
  const correctionCandidate = rawIssue.correctionMovement?.id ? rawIssue.correctionMovement : movementsById.get(correctionMovementId);
  const correctionMovement = normalizeTraceMovement(correctionCandidate);
  const status = !originalMovement ? "unknown" : originalMovement.correctedByMovementId ? "corrected" : "active";
  const workOrderCandidate = rawIssue.workOrder?.id ? rawIssue.workOrder : workOrdersById.get(issue.workOrderId);
  const workOrder = normalizeTraceWorkOrder(workOrderCandidate);
  const createdAt = issue.createdAt || originalMovement?.createdAt || "";
  const qty = Number(issue.qty || 0);

  return {
    ...issue,
    materialBatchId: issue.materialBatchId || "",
    resolvedMaterialBatchId: batch.id,
    status,
    statusLabel: traceStatusLabel(status),
    historicalQty: qty,
    effectiveQty: status === "active" ? qty : 0,
    netQty: status === "active" ? qty : 0,
    unknownQty: status === "unknown" ? qty : 0,
    correctionMovementId,
    correctionReason: originalMovement?.correctionReason || correctionMovement?.correctionReason || issue.correctionReason || "",
    correctedAt: originalMovement?.correctedAt || correctionMovement?.createdAt || issue.correctedAt || "",
    createdAt,
    stockMovement: originalMovement,
    originalMovement,
    correctionMovement,
    workOrder,
  };
}

function summarizeTraceGroup(group) {
  const status = group.activeIssueCount > 0 ? "active" : group.unknownIssueCount > 0 ? "unknown" : "corrected";
  return {
    workOrderId: group.workOrderId,
    workOrder: group.workOrder,
    issueCount: group.issues.length,
    historicalQty: group.historicalQty,
    effectiveNetQty: group.effectiveNetQty,
    correctedQty: group.correctedQty,
    unknownQty: group.unknownQty,
    activeIssueCount: group.activeIssueCount,
    correctedIssueCount: group.correctedIssueCount,
    unknownIssueCount: group.unknownIssueCount,
    latestIssueAt: group.latestIssueAt,
    status,
    statusLabel: traceStatusLabel(status),
    issues: group.issues,
  };
}

export function buildMaterialBatchWorkOrderTrace({ batch, material = null, issues = [], stockMovements = [], workOrders = [] } = {}) {
  const materialBatch = {
    ...batch,
    id: String(batch?.id || "").trim(),
    materialCode: String(batch?.materialCode || "").trim(),
    batchNo: String(batch?.batchNo || "").trim(),
    initialQty: Number(batch?.initialQty || 0),
    stockQty: Number(batch?.stockQty || 0),
  };
  const materialView = material
    ? { ...material, unit: materialUnitLabel(material), safetyQty: toOptionalNumber(material.safetyQty) }
    : null;
  const movementsById = new Map(stockMovements.map((item) => [String(item?.id || "").trim(), item]));
  const workOrdersById = new Map(workOrders.map((item) => [String(item?.id || "").trim(), item]));
  const traceIssues = issues
    .map((issue, index) => ({ issue: normalizeTraceIssue(issue, materialBatch, movementsById, workOrdersById), index }))
    .sort((left, right) => compareTraceDates(left.issue.createdAt, right.issue.createdAt) || left.index - right.index)
    .map(({ issue }) => issue);

  const groups = new Map();
  let historicalQty = 0;
  let effectiveNetQty = 0;
  let unknownQty = 0;
  let correctedQty = 0;
  let activeIssueCount = 0;
  let correctedIssueCount = 0;
  let unknownIssueCount = 0;

  for (const issue of traceIssues) {
    historicalQty = addDecimalQuantities(historicalQty, issue.qty);
    if (issue.status === "active") {
      effectiveNetQty = addDecimalQuantities(effectiveNetQty, issue.qty);
      activeIssueCount += 1;
    } else if (issue.status === "corrected") {
      correctedQty = addDecimalQuantities(correctedQty, issue.qty);
      correctedIssueCount += 1;
    } else {
      unknownQty = addDecimalQuantities(unknownQty, issue.qty);
      unknownIssueCount += 1;
    }

    const workOrderId = issue.workOrderId || "";
    const groupKey = workOrderId || "__unknown_work_order__";
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        workOrderId,
        workOrder: issue.workOrder,
        issues: [],
        historicalQty: 0,
        effectiveNetQty: 0,
        correctedQty: 0,
        unknownQty: 0,
        activeIssueCount: 0,
        correctedIssueCount: 0,
        unknownIssueCount: 0,
        latestIssueAt: issue.createdAt || "",
      });
    }
    const group = groups.get(groupKey);
    group.issues.push(issue);
    group.workOrder ||= issue.workOrder;
    group.historicalQty = addDecimalQuantities(group.historicalQty, issue.qty);
    group.latestIssueAt = compareTraceDates(group.latestIssueAt, issue.createdAt) <= 0 ? group.latestIssueAt : issue.createdAt;
    if (issue.status === "active") {
      group.effectiveNetQty = addDecimalQuantities(group.effectiveNetQty, issue.qty);
      group.activeIssueCount += 1;
    } else if (issue.status === "corrected") {
      group.correctedQty = addDecimalQuantities(group.correctedQty, issue.qty);
      group.correctedIssueCount += 1;
    } else {
      group.unknownQty = addDecimalQuantities(group.unknownQty, issue.qty);
      group.unknownIssueCount += 1;
    }
  }

  const workOrderGroups = Array.from(groups.values())
    .sort((left, right) => compareTraceDates(left.latestIssueAt, right.latestIssueAt) || left.workOrderId.localeCompare(right.workOrderId))
    .map(summarizeTraceGroup);
  const summary = {
    historicalIssueCount: traceIssues.length,
    historicalWorkOrderCount: workOrderGroups.length,
    activeWorkOrderCount: workOrderGroups.filter((item) => item.activeIssueCount > 0).length,
    historicalQty,
    historicalIssueQty: historicalQty,
    effectiveNetQty,
    activeIssueCount,
    correctedIssueCount,
    correctedQty,
    unknownIssueCount,
    unknownWorkOrderCount: workOrderGroups.filter((item) => item.unknownIssueCount > 0).length,
    unknownQty,
  };

  return {
    batch: {
      ...materialBatch,
      materialName: materialView?.name || "",
      unit: materialView?.unit || "",
    },
    material: materialView,
    summary,
    stats: summary,
    workOrders: workOrderGroups,
    issues: traceIssues,
  };
}

function issueMatchesMaterialBatch(issue, batch) {
  const materialBatchId = String(issue?.materialBatchId || "").trim();
  if (materialBatchId) return materialBatchId === batch.id;
  return String(issue?.materialCode || "").trim() === batch.materialCode && String(issue?.batchNo || "").trim() === batch.batchNo;
}

function buildMaterialBatchTraceFromState(state, batchId) {
  const id = requireMaterialBatchId(batchId);
  const batch = (state.materialBatches || []).find((item) => String(item?.id || "").trim() === id);
  if (!batch) throw createStoreError("NOT_FOUND", "物料批次不存在");
  const material = (state.materialItems || []).find((item) => item.code === batch.materialCode) || null;
  const issues = (state.workOrderMaterialIssues || []).filter((issue) => issueMatchesMaterialBatch(issue, batch));
  return buildMaterialBatchWorkOrderTrace({
    batch,
    material,
    issues,
    stockMovements: state.stockMovements || [],
    workOrders: state.workOrders || [],
  });
}

function attachWorkOrderIssueLinks(stockMovements = [], issues = []) {
  const issueByMovementId = new Map(issues.map((issue) => [issue.stockMovementId, issue]));
  return stockMovements.map((movement) => {
    const issue = issueByMovementId.get(movement.id) || issueByMovementId.get(movement.correctionOfMovementId);
    if (!issue) return movement;
    return {
      ...movement,
      workOrderId: issue.workOrderId,
      workOrderMaterialIssueId: issue.id,
      workOrderIssueStatus: issue.status,
    };
  });
}

function movementTypeLabel(type) {
  return type === "out" ? "出库" : "入库";
}

function assertCorrectionInput(original, batch, reason) {
  if (!original) throw new Error("原始出入库流水不存在");
  if (original.correctedByMovementId) throw new Error("这条流水已经冲正，不能重复冲正");
  if (original.correctionOfMovementId) throw new Error("冲正流水不能再次冲正");
  if (!["in", "out"].includes(original.type)) throw new Error("当前只支持入库 / 出库流水冲正");
  if (!String(reason || "").trim()) throw new Error("冲正原因不能为空");
  if (!batch) throw new Error("物料批次不存在");
  if (original.type === "in" && Number(original.qty || 0) > Number(batch.stockQty || 0)) {
    throw new Error("冲正后库存会变负，请先核对当前库存");
  }
}

function dateOnly(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const matched = value.match(/^\d{4}-\d{2}-\d{2}/);
    return matched ? matched[0] : "";
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return "";
}

function addDays(dateValue, days) {
  const date = dateValue instanceof Date ? new Date(dateValue) : new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return dateOnly(date);
}

export const EXPIRING_SOON_DAYS = 30;

export function getDaysUntilExpiry(batch, now = new Date()) {
  const expiryDate = dateOnly(batch?.expiryDate);
  if (!expiryDate) return null;
  const todayDate = new Date(dateOnly(now));
  const expiry = new Date(expiryDate);
  return Math.round((expiry.getTime() - todayDate.getTime()) / 86400000);
}

export function getBatchExpiryStatus(batch, now = new Date()) {
  if (Number(batch?.stockQty || 0) <= 0) return "已用完";
  const expiryDate = dateOnly(batch?.expiryDate);
  if (!expiryDate) return "正常";
  const today = dateOnly(now);
  if (expiryDate < today) return "已过期";
  if (expiryDate <= addDays(now, EXPIRING_SOON_DAYS)) return "即将过期";
  return "正常";
}

export function getBatchRiskStatus(batch, material = {}, now = new Date()) {
  return {
    status: getBatchExpiryStatus(batch, now),
    daysUntilExpiry: getDaysUntilExpiry(batch, now),
    lowStock: false,
    unit: material.unit || "",
  };
}

function normalizeMaterialItemInput(input = {}, fallback = {}) {
  return {
    code: String(input.code || fallback.code || "").trim(),
    name: String(input.name || fallback.name || "").trim(),
    spec: String(input.spec ?? fallback.spec ?? "").trim(),
    unit: String(input.unit || fallback.unit || "kg").trim(),
    safetyQty: Number(input.safetyQty ?? fallback.safetyQty ?? 0),
    defaultLocation: String(input.defaultLocation || fallback.defaultLocation || fallback.location || "").trim(),
    supplier: String(input.supplier || fallback.supplier || "").trim(),
    status: String(input.status || fallback.status || "启用").trim() || "启用",
  };
}

function materialUnitLabel(material = {}) {
  const unit = String(material.unit || "kg").trim();
  return unit && !/^\d+(\.\d+)?$/.test(unit) ? unit : "kg";
}

function assertMaterialItemInput(material, existingItems = [], originalCode = "") {
  if (!material.code) throw new Error("物料编号不能为空");
  if (!material.name) throw new Error("物料名称不能为空");
  if (!material.unit) throw new Error("单位不能为空");
  if (/^\d+(\.\d+)?$/.test(material.unit)) throw new Error("计量单位不能是纯数字，请填写 kg、张、片等单位");
  if (!Number.isFinite(material.safetyQty) || material.safetyQty < 0) throw new Error("安全库存必须是非负数");
  const duplicated = existingItems.some((item) => item.code === material.code && item.code !== originalCode);
  if (duplicated) throw new Error("物料编号不能重复");
}

function normalizeMaterialBatchInput(input = {}, material = {}) {
  const today = dateOnly(new Date());
  return {
    materialCode: String(input.materialCode || material.code || "").trim(),
    batchNo: String(input.batchNo || "").trim(),
    initialQty: Number(input.initialQty ?? input.qty ?? 0),
    stockQty: Number(input.stockQty ?? input.initialQty ?? input.qty ?? 0),
    location: String(input.location || material.defaultLocation || "").trim(),
    receivedDate: dateOnly(input.receivedDate) || today,
    expiryDate: dateOnly(input.expiryDate),
    supplier: String(input.supplier || material.supplier || "").trim(),
    note: String(input.note || "").trim(),
  };
}

function assertMaterialBatchInput(batch, materialItems = [], existingBatches = []) {
  if (!batch.materialCode) throw new Error("物料必选");
  if (!materialItems.some((item) => item.code === batch.materialCode)) throw new Error("物料档案不存在");
  if (!batch.batchNo) throw new Error("批次号不能为空");
  if (!Number.isFinite(batch.initialQty) || batch.initialQty <= 0) throw new Error("入库数量必须大于 0");
  if (!Number.isInteger(batch.initialQty)) throw new Error("入库数量不能是小数");
  if (!batch.location) throw new Error("库位不能为空");
  if (!batch.receivedDate) throw new Error("来料日期不能为空");
  if (!batch.expiryDate) throw new Error("保质期截止日期不能为空");
  if (batch.expiryDate < batch.receivedDate) throw new Error("保质期截止日期不能早于来料日期");
  if (existingBatches.some((item) => item.materialCode === batch.materialCode && item.batchNo === batch.batchNo)) {
    throw new Error("同一物料下批次号不能重复");
  }
}

function normalizeMaterialItemRecord(input = {}) {
  const now = new Date().toISOString();
  const material = normalizeMaterialItemInput(input);
  return {
    ...material,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
}

function normalizeMaterialBatchRecord(input = {}, material = {}) {
  const now = new Date().toISOString();
  const batch = normalizeMaterialBatchInput(input, material);
  return {
    id: input.id || makeId("mb"),
    ...batch,
    initialQty: Number(input.initialQty ?? batch.initialQty ?? input.stockQty ?? 0),
    stockQty: Number(input.stockQty ?? batch.stockQty ?? input.initialQty ?? 0),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
}

export function normalizeLegacyMaterials(data = {}) {
  const legacyMaterials = Array.isArray(data.materials) ? data.materials : [];
  const materialItems = Array.isArray(data.materialItems) && data.materialItems.length
    ? data.materialItems.map(normalizeMaterialItemRecord)
    : [];
  const materialBatches = Array.isArray(data.materialBatches) && data.materialBatches.length
    ? data.materialBatches.map((item) => normalizeMaterialBatchRecord(item))
    : [];

  for (const legacy of legacyMaterials) {
    if (!legacy?.code) continue;
    if (!materialItems.some((item) => item.code === legacy.code)) {
      materialItems.push(
        normalizeMaterialItemRecord({
          code: legacy.code,
          name: legacy.name,
          spec: legacy.spec,
          unit: legacy.unit,
          safetyQty: legacy.safetyQty,
          defaultLocation: legacy.location,
          supplier: legacy.supplier,
          status: "启用",
        })
      );
    }
    if (legacy.batchNo && !materialBatches.some((item) => item.materialCode === legacy.code && item.batchNo === legacy.batchNo)) {
      materialBatches.push(
        normalizeMaterialBatchRecord({
          id: legacy.id || `legacy-${legacy.code}-${legacy.batchNo}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
          materialCode: legacy.code,
          batchNo: legacy.batchNo,
          initialQty: Number(legacy.initialQty ?? legacy.stockQty ?? 0),
          stockQty: Number(legacy.stockQty ?? 0),
          location: legacy.location,
          receivedDate: legacy.receivedDate || legacy.createdAt || dateOnly(new Date()),
          expiryDate: legacy.expiryDate,
          supplier: legacy.supplier,
          note: legacy.note || "历史库存迁移",
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt,
        })
      );
    }
  }

  return { materialItems, materialBatches };
}

function buildCompatMaterials(materialItems = [], materialBatches = []) {
  return materialBatches.map((batch) => {
    const material = materialItems.find((item) => item.code === batch.materialCode) || {};
    return {
      code: batch.materialCode,
      name: material.name || "历史库存",
      spec: material.spec || "",
      stockQty: Number(batch.stockQty || 0),
      safetyQty: Number(material.safetyQty || 0),
      unit: material.unit || "",
      location: batch.location || material.defaultLocation || "",
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate || "",
      receivedDate: batch.receivedDate || "",
      supplier: batch.supplier || material.supplier || "",
      materialBatchId: batch.id,
      batchStatus: getBatchExpiryStatus(batch),
      daysUntilExpiry: getDaysUntilExpiry(batch),
    };
  });
}

export function getMaterialBatches(materialCode, state = {}) {
  return (state.materialBatches || []).filter((batch) => batch.materialCode === materialCode);
}

export function getMaterialStockSummary(materialCode, state = {}) {
  const material = (state.materialItems || []).find((item) => item.code === materialCode) || {};
  const batches = getMaterialBatches(materialCode, state);
  const totalStockQty = batches.reduce((sum, batch) => sum + Number(batch.stockQty || 0), 0);
  const activeExpiryDates = batches
    .filter((batch) => Number(batch.stockQty || 0) > 0 && batch.expiryDate)
    .map((batch) => batch.expiryDate)
    .sort();
  return {
    materialCode,
    name: material.name || "",
    spec: material.spec || "",
    unit: material.unit || "",
    safetyQty: Number(material.safetyQty || 0),
    totalStockQty,
    batchCount: batches.length,
    nearestExpiryDate: activeExpiryDates[0] || "",
    lowStock: totalStockQty < Number(material.safetyQty || 0),
    expiringSoonBatchCount: batches.filter((batch) => getBatchExpiryStatus(batch) === "即将过期").length,
    expiredBatchCount: batches.filter((batch) => getBatchExpiryStatus(batch) === "已过期").length,
    usedUpBatchCount: batches.filter((batch) => getBatchExpiryStatus(batch) === "已用完").length,
    status: material.status || "启用",
  };
}

function getMaterialSummaries(state = {}) {
  return (state.materialItems || []).map((item) => getMaterialStockSummary(item.code, state));
}

function sortBatchesForFefo(left, right) {
  const leftExpiry = dateOnly(left.expiryDate) || "9999-12-31";
  const rightExpiry = dateOnly(right.expiryDate) || "9999-12-31";
  if (leftExpiry !== rightExpiry) return leftExpiry.localeCompare(rightExpiry);
  const leftReceived = dateOnly(left.receivedDate) || "9999-12-31";
  const rightReceived = dateOnly(right.receivedDate) || "9999-12-31";
  if (leftReceived !== rightReceived) return leftReceived.localeCompare(rightReceived);
  return String(left.batchNo || "").localeCompare(String(right.batchNo || ""));
}

export function buildFefoIssuePlan(materialCode, qty, state = {}, options = {}) {
  const requestedQty = Number(qty || 0);
  const now = options.now || new Date();
  const includeExpired = Boolean(options.includeExpired);
  const material = (state.materialItems || []).find((item) => item.code === materialCode) || {};
  const unit = materialUnitLabel(material);
  const allUsable = getMaterialBatches(materialCode, state)
    .filter((batch) => Number(batch.stockQty || 0) > 0)
    .map((batch) => ({
      ...batch,
      batchStatus: getBatchExpiryStatus(batch, now),
      daysUntilExpiry: getDaysUntilExpiry(batch, now),
    }));
  const nonExpired = allUsable.filter((batch) => batch.batchStatus !== "已过期");
  const candidates = (includeExpired ? allUsable : nonExpired).sort(sortBatchesForFefo);
  const plan = [];
  let remainingQty = Math.max(0, requestedQty);
  for (const batch of candidates) {
    if (remainingQty <= 0) break;
    const issueQty = Math.min(Number(batch.stockQty || 0), remainingQty);
    if (issueQty <= 0) continue;
    plan.push({
      materialCode: batch.materialCode,
      batchNo: batch.batchNo,
      qty: issueQty,
      stockQty: Number(batch.stockQty || 0),
      location: batch.location || material.defaultLocation || "",
      expiryDate: batch.expiryDate || "",
      receivedDate: batch.receivedDate || "",
      status: batch.batchStatus,
      daysUntilExpiry: batch.daysUntilExpiry,
      unit,
    });
    remainingQty -= issueQty;
  }
  const expiredAvailableQty = allUsable
    .filter((batch) => batch.batchStatus === "已过期")
    .reduce((sum, batch) => sum + Number(batch.stockQty || 0), 0);
  return {
    materialCode,
    requestedQty,
    unit,
    recommendedBatch: plan[0] || null,
    plan,
    remainingQty,
    isEnough: requestedQty > 0 && remainingQty <= 0,
    hasUnexpiredStock: nonExpired.length > 0,
    expiredAvailableQty,
  };
}

function assertFefoStockMovement(movement, batch, state = {}, now = new Date()) {
  if (movement.type !== "out") return null;
  const batchStatus = getBatchExpiryStatus(batch, now);
  const reason = String(movement.overrideReason || "").trim();
  if (batchStatus === "已过期" && !reason) {
    throw new Error("当前批次已过期，强制出库必须填写原因");
  }
  if (batchStatus !== "已过期") {
    const plan = buildFefoIssuePlan(movement.materialCode, movement.qty, state, { now });
    const recommended = plan.recommendedBatch;
    if (recommended && recommended.batchNo !== movement.batchNo && !reason) {
      throw new Error(`当前不是 FEFO 推荐批次，请填写原因后再出库；建议优先使用 ${recommended.batchNo}`);
    }
    return plan;
  }
  return buildFefoIssuePlan(movement.materialCode, movement.qty, state, { now, includeExpired: true });
}

function hydrateInventoryState(data) {
  const migrated = normalizeLegacyMaterials(data);
  const materialItems = migrated.materialItems;
  const materialBatches = migrated.materialBatches;
  return {
    materialItems,
    materialBatches,
    materials: buildCompatMaterials(materialItems, materialBatches),
    materialSummaries: getMaterialSummaries({ materialItems, materialBatches }),
  };
}

function syncCompatInventory(state) {
  const inventory = hydrateInventoryState(state);
  state.materialItems = inventory.materialItems;
  state.materialBatches = inventory.materialBatches;
  state.materials = inventory.materials;
  state.materialSummaries = inventory.materialSummaries;
  return state;
}

function normalizeState(data) {
  const inventory = hydrateInventoryState(data);
  return {
    users: data.users || [],
    samples: data.samples || [],
    workOrders: data.workOrders || [],
    materialItems: inventory.materialItems,
    materialBatches: inventory.materialBatches,
    materialSummaries: inventory.materialSummaries,
    materials: inventory.materials,
    reports: data.reports || [],
    stockMovements: data.stockMovements || [],
    workOrderMaterialIssues: (data.workOrderMaterialIssues || []).map(normalizeWorkOrderMaterialIssueRecord),
    activities: data.activities || [],
    alerts: data.alerts || [],
  };
}

function serializePublicState(data) {
  const state = normalizeState(data);
  const workOrderMaterialIssues = enrichWorkOrderMaterialIssues(state.workOrderMaterialIssues, state.stockMovements);
  const stockMovements = attachWorkOrderIssueLinks(state.stockMovements, workOrderMaterialIssues);
  return {
    samples: state.samples,
    workOrders: state.workOrders,
    materialItems: state.materialItems,
    materialBatches: state.materialBatches,
    materialSummaries: state.materialSummaries,
    materials: state.materials,
    reports: state.reports,
    stockMovements,
    workOrderMaterialIssues,
    activities: state.activities,
    alerts: state.alerts,
    stats: [
      { label: "进行中生产单", value: state.workOrders.filter((item) => item.status === "生产中").length },
      { label: "待处理预警", value: state.alerts.filter((item) => item.status === "open").length },
      { label: "打样项目", value: state.samples.length },
      { label: "今日报工次数", value: state.reports.length },
    ],
  };
}

function serializeStateForRole(data, role) {
  const state = normalizeState(data);
  if (role === "manager") {
    return serializePublicState(state);
  }

  if (role === "worker" || role === "warehouse") {
    const workOrders = state.workOrders.filter((item) => item.status !== "已完成");
    const materials = state.materials;
    const alerts = state.alerts.filter((item) => item.status === "open");
    const reports = state.reports.slice(0, 200);
    const stockMovements = attachWorkOrderIssueLinks(
      state.stockMovements.slice(0, 30),
      enrichWorkOrderMaterialIssues(state.workOrderMaterialIssues, state.stockMovements)
    );
    return {
      samples: [],
      workOrders,
      materials,
      reports,
      stockMovements,
      activities: state.activities.slice(0, 16),
      alerts,
      stats: [
        { label: "待办工单", value: workOrders.length },
        { label: "批次物料", value: materials.length },
        { label: "待处理预警", value: alerts.length },
      ],
    };
  }

  return serializePublicState(state);
}

export async function createStore(rootDir) {
  const postgresRequired = isPostgresRequired();

  if (!process.env.DATABASE_URL) {
    if (postgresRequired) {
      throw new Error("PostgreSQL is required but DATABASE_URL is not configured");
    }
    return createFileStore(rootDir);
  }

  try {
    return await createPostgresStore();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown PostgreSQL error";
    if (postgresRequired) {
      console.error("PostgreSQL is required but unavailable:", message);
      throw new Error(`PostgreSQL is required but unavailable: ${message}`);
    }
    console.warn("PostgreSQL unavailable, falling back to file store:", message);
  }
  return createFileStore(rootDir);
}

function isPostgresRequired() {
  const value = String(process.env.REQUIRE_POSTGRES || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value) || process.env.NODE_ENV === "production";
}

async function createFileStore(rootDir) {
  const dataDir = join(rootDir, "data");
  const dataFile = join(dataDir, "alpha-store.json");
  await mkdir(dataDir, { recursive: true });

  async function readState() {
    try {
      return normalizeState(JSON.parse(await readFile(dataFile, "utf8")));
    } catch {
      const initialState = normalizeState(clone(seedData));
      await writeState(initialState);
      return initialState;
    }
  }

  async function writeState(state) {
    syncCompatInventory(state);
    const tempFile = `${dataFile}.${makeId("write")}.tmp`;
    await writeFile(tempFile, JSON.stringify(state, null, 2), "utf8");
    await rename(tempFile, dataFile);
  }

  return {
    kind: "file",
    async findUser(username, password) {
      const state = await readState();
      const user = state.users.find((item) => item.username === username && item.password === password);
      if (!user) return null;
      return { id: user.id, name: user.name, role: user.role };
    },
    async getState(role = "manager") {
      return serializeStateForRole(await readState(), role);
    },
    async createSample(input) {
      const state = await readState();
      const sample = normalizeSampleInput(input);
      assertSampleInput(sample);
      const next = {
        id: input.id?.trim() || makeBusinessId("SP", state.samples.map((item) => item.id)),
        ...sample,
      };
      state.samples.unshift(next);
      state.activities.unshift({
        id: makeId("act"),
        title: `${next.id} 已新建`,
        meta: `${input.operator} · 刚刚`,
        note: `${next.name} / ${next.customer || "未填写客户"} · ${next.status}`,
        createdAt: new Date().toISOString(),
      });
      await writeState(state);
      return { sample: next, state: serializePublicState(state) };
    },
    async updateSample(sampleId, input) {
      const state = await readState();
      const sample = state.samples.find((item) => item.id === sampleId);
      if (!sample) throw new Error("样品单不存在");
      const next = normalizeSampleInput(input, sample);
      assertSampleInput(next);
      Object.assign(sample, next);
      state.activities.unshift({
        id: makeId("act"),
        title: `${sample.id} 已更新`,
        meta: `${input.operator} · 刚刚`,
        note: `${sample.name} / ${sample.version || "未填写版本"} / ${sample.status}`,
        createdAt: new Date().toISOString(),
      });
      await writeState(state);
      return { sample, state: serializePublicState(state) };
    },
    async createWorkOrder(input) {
      const state = await readState();
      const order = normalizeOrderInput(input);
      assertOrderInput(order);
      const next = {
        id: input.id?.trim() || makeBusinessId("WO", state.workOrders.map((item) => item.id)),
        ...order,
      };
      state.workOrders.unshift(next);
      state.activities.unshift({
        id: makeId("act"),
        title: `${next.id} 已新建`,
        meta: `${input.operator} · 刚刚`,
        note: `${next.product} · ${next.plannedQty} 双 · ${next.currentProcess}`,
        createdAt: new Date().toISOString(),
      });
      await writeState(state);
      return { workOrder: next, state: serializePublicState(state) };
    },
    async updateWorkOrder(workOrderId, input) {
      const state = await readState();
      const order = state.workOrders.find((item) => item.id === workOrderId);
      if (!order) throw new Error("工单不存在");
      const next = normalizeOrderInput(input, order);
      assertOrderInput(next);
      Object.assign(order, next);
      state.activities.unshift({
        id: makeId("act"),
        title: `${order.id} 已更新`,
        meta: `${input.operator} · 刚刚`,
        note: `${order.product} · ${order.status} · ${order.currentProcess}`,
        createdAt: new Date().toISOString(),
      });
      await writeState(state);
      return { workOrder: order, state: serializePublicState(state) };
    },
    async createReport(input) {
      const state = await readState();
      const order = state.workOrders.find((item) => item.id === input.workOrderId);
      if (!order) throw new Error("工单不存在");
      const normalized = normalizeReportInput(input, order);
      assertReportInput(normalized, order, state.reports);
      const report = {
        id: makeId("rep"),
        ...normalized,
        createdAt: new Date().toISOString(),
      };
      applyReportProgress(order, state.reports, report);
      state.reports.unshift(report);
      state.activities.unshift({
        id: makeId("act"),
        title: `${order.id} 提交${report.processName}报工`,
        meta: `${input.operator} · 刚刚`,
        note: `完成 ${report.completedQty}，良品 ${report.goodQty}，不良 ${report.badQty}${report.badReason ? `，${report.badReason}` : ""}`,
        createdAt: report.createdAt,
      });
      if (report.badQty > 0 || report.note) {
        state.alerts.unshift({
          id: makeId("al"),
          title: `${order.id} 现场异常`,
          text: `${report.processName}：${report.badReason || report.note || `不良 ${report.badQty}`}`,
          severity: report.badQty > 0 ? "high" : "medium",
          status: "open",
          createdAt: report.createdAt,
        });
      }
      await writeState(state);
      return { report, state: serializePublicState(state) };
    },
    async createMaterialItem(input) {
      const state = await readState();
      const material = normalizeMaterialItemRecord(input);
      assertMaterialItemInput(material, state.materialItems);
      state.materialItems.unshift(material);
      state.activities.unshift({
        id: makeId("act"),
        title: `${material.code} 物料已建档`,
        meta: `${input.operator} · 刚刚`,
        note: `${material.name} / ${material.unit} / 安全库存 ${material.safetyQty}${material.unit}`,
        createdAt: material.createdAt,
      });
      await writeState(state);
      return { material, state: serializePublicState(state) };
    },
    async updateMaterialItem(materialCode, input) {
      const state = await readState();
      const existing = state.materialItems.find((item) => item.code === materialCode);
      if (!existing) throw new Error("物料档案不存在");
      const next = {
        ...existing,
        ...normalizeMaterialItemInput({ ...input, code: materialCode }, existing),
        updatedAt: new Date().toISOString(),
      };
      assertMaterialItemInput(next, state.materialItems, materialCode);
      Object.assign(existing, next);
      state.activities.unshift({
        id: makeId("act"),
        title: `${existing.code} 物料已更新`,
        meta: `${input.operator} · 刚刚`,
        note: `${existing.name} / ${existing.unit} / 安全库存 ${existing.safetyQty}${existing.unit}`,
        createdAt: existing.updatedAt,
      });
      await writeState(state);
      return { material: existing, state: serializePublicState(state) };
    },
    async createMaterialBatch(input) {
      const state = await readState();
      const material = state.materialItems.find((item) => item.code === input.materialCode);
      const batch = normalizeMaterialBatchRecord(input, material);
      assertMaterialBatchInput(batch, state.materialItems, state.materialBatches);
      const movement = {
        id: makeId("stk"),
        materialCode: batch.materialCode,
        batchNo: batch.batchNo,
        type: "in",
        qty: batch.initialQty,
        location: batch.location,
        note: batch.note || "新建批次入库",
        operator: input.operator,
        source: "admin",
        beforeQty: 0,
        afterQty: batch.stockQty,
        materialBatchId: batch.id,
        createdAt: new Date().toISOString(),
      };
      state.materialBatches.unshift(batch);
      state.stockMovements.unshift(movement);
      state.activities.unshift({
        id: makeId("act"),
        title: `${material.name} 新批次入库`,
        meta: `${input.operator} · 刚刚`,
        note: `${batch.batchNo} · ${batch.initialQty}${material.unit} · ${batch.location}`,
        createdAt: movement.createdAt,
      });
      await writeState(state);
      return { batch, movement, state: serializePublicState(state) };
    },
    async getFefoRecommendation(materialCode, qty, options = {}) {
      const state = await readState();
      return buildFefoIssuePlan(materialCode, qty, state, options);
    },
    async getWorkOrderMaterialIssues(workOrderId) {
      const state = await readState();
      const order = state.workOrders.find((item) => item.id === workOrderId);
      if (!order) throw new Error("工单不存在");
      const issues = enrichWorkOrderMaterialIssues(state.workOrderMaterialIssues, state.stockMovements)
        .filter((item) => item.workOrderId === workOrderId);
      return { issues };
    },
    async getMaterialBatchWorkOrderIssues(batchId) {
      const state = await readState();
      return buildMaterialBatchTraceFromState(state, batchId);
    },
    async createWorkOrderMaterialIssue(workOrderId, input) {
      const state = await readState();
      const order = state.workOrders.find((item) => item.id === workOrderId);
      if (!order) throw new Error("工单不存在");
      assertWorkOrderMaterialIssueStatus(order);

      const issueInput = normalizeWorkOrderMaterialIssueInput(workOrderId, input);
      if (!issueInput.operator) throw new Error("操作人不能为空");
      const material = state.materialItems.find((item) => item.code === issueInput.materialCode);
      if (!material) throw new Error("物料档案不存在");
      const batch = state.materialBatches.find((item) => item.materialCode === issueInput.materialCode && item.batchNo === issueInput.batchNo);
      if (!batch) throw new Error("物料批次不存在或不属于所选物料");

      const movementInput = { ...issueInput, type: "out" };
      assertStockMovementInput(movementInput, batch.stockQty);
      const fefoPlan = assertFefoStockMovement(movementInput, batch, state);
      const beforeQty = Number(batch.stockQty || 0);
      const afterQty = addDecimalQuantities(beforeQty, -movementInput.qty);
      const createdAt = new Date().toISOString();
      const movement = {
        id: makeId("stk"),
        materialCode: batch.materialCode,
        batchNo: batch.batchNo,
        type: "out",
        qty: movementInput.qty,
        location: movementInput.location || batch.location,
        note: [movementInput.note, movementInput.overrideReason ? `FEFO原因：${movementInput.overrideReason}` : ""].filter(Boolean).join("；"),
        operator: issueInput.operator,
        source: "work_order_issue",
        beforeQty,
        afterQty,
        materialBatchId: batch.id,
        overrideReason: movementInput.overrideReason,
        recommendedBatchNo: fefoPlan?.recommendedBatch?.batchNo || "",
        createdAt,
      };
      const issue = buildWorkOrderMaterialIssue({ order, material, batch, movement, fefoPlan, input: issueInput });

      batch.stockQty = afterQty;
      batch.updatedAt = createdAt;
      if (movement.location) batch.location = movement.location;
      state.stockMovements.unshift(movement);
      state.workOrderMaterialIssues.unshift(issue);
      state.activities.unshift({
        id: makeId("act"),
        title: `${order.id} 工单领料`,
        meta: `${issueInput.operator} · 刚刚`,
        note: `${material.name} / ${batch.batchNo} / ${movement.qty}${material.unit || ""}`,
        createdAt,
      });
      await writeState(state);
      return { issue, movement, state: serializePublicState(state) };
    },
    async createStockMovement(input) {
      const state = await readState();
      const movementInput = normalizeStockMovementInput(input);
      const batch = state.materialBatches.find((item) => item.materialCode === movementInput.materialCode && item.batchNo === movementInput.batchNo);
      if (!batch) throw new Error("物料批次不存在");
      const material = state.materialItems.find((item) => item.code === batch.materialCode) || {};
      assertStockMovementInput(movementInput, batch.stockQty);
      const fefoPlan = assertFefoStockMovement(movementInput, batch, state);
      const qty = movementInput.qty;
      const sign = movementInput.type === "out" ? -1 : 1;
      const beforeQty = Number(batch.stockQty || 0);
      const nextQty = beforeQty + sign * qty;
      batch.stockQty = nextQty;
      batch.updatedAt = new Date().toISOString();
      if (movementInput.location) batch.location = movementInput.location;
      const movement = {
        id: makeId("stk"),
        materialCode: movementInput.materialCode,
        batchNo: movementInput.batchNo,
        type: movementInput.type,
        qty,
        location: movementInput.location || batch.location,
        note: [movementInput.note, movementInput.overrideReason ? `FEFO原因：${movementInput.overrideReason}` : ""].filter(Boolean).join("；"),
        operator: input.operator,
        source: input.source || "mobile",
        beforeQty,
        afterQty: nextQty,
        materialBatchId: batch.id,
        overrideReason: movementInput.overrideReason,
        recommendedBatchNo: fefoPlan?.recommendedBatch?.batchNo || "",
        createdAt: new Date().toISOString(),
      };
      state.stockMovements.unshift(movement);
      state.activities.unshift({
        id: makeId("act"),
        title: `${material.name || movement.materialCode} ${movement.type === "out" ? "出库" : "入库"}`,
        meta: `${input.operator} · 刚刚`,
        note: `${movement.batchNo} · ${qty}${material.unit || ""} · ${movement.location}`,
        createdAt: movement.createdAt,
      });
      const summary = getMaterialStockSummary(batch.materialCode, state);
      if (summary.lowStock) {
        state.alerts.unshift({
          id: makeId("al"),
          title: `${material.name || batch.materialCode} 库存不足`,
          text: `${batch.materialCode} 当前 ${summary.totalStockQty}${material.unit || ""}，低于安全库存 ${summary.safetyQty}${material.unit || ""}。`,
          severity: "high",
          status: "open",
          createdAt: movement.createdAt,
        });
      }
      await writeState(state);
      return { movement, state: serializePublicState(state) };
    },
    async correctStockMovement(movementId, input = {}) {
      const state = await readState();
      const original = state.stockMovements.find((item) => item.id === movementId);
      const batch = original ? state.materialBatches.find((item) => item.materialCode === original.materialCode && item.batchNo === original.batchNo) : null;
      const reason = String(input.correctionReason || input.reason || "").trim();
      assertCorrectionInput(original, batch, reason);
      const material = state.materialItems.find((item) => item.code === original.materialCode) || {};
      const type = original.type === "in" ? "out" : "in";
      const qty = Number(original.qty || 0);
      const beforeQty = Number(batch.stockQty || 0);
      const afterQty = original.type === "in" ? beforeQty - qty : beforeQty + qty;
      const createdAt = new Date().toISOString();
      batch.stockQty = afterQty;
      batch.updatedAt = createdAt;
      const correction = {
        id: makeId("stk"),
        materialCode: original.materialCode,
        batchNo: original.batchNo,
        type,
        qty,
        location: original.location || batch.location,
        note: `冲正 ${original.id}：${reason}`,
        operator: input.operator,
        source: "correction",
        beforeQty,
        afterQty,
        materialBatchId: original.materialBatchId || batch.id,
        correctionOfMovementId: original.id,
        correctionReason: reason,
        createdAt,
      };
      original.correctedByMovementId = correction.id;
      original.correctedAt = createdAt;
      original.correctionReason = reason;
      state.stockMovements.unshift(correction);
      state.activities.unshift({
        id: makeId("act"),
        title: `${material.name || correction.materialCode} ${movementTypeLabel(original.type)}已冲正`,
        meta: `${input.operator} · 刚刚`,
        note: `${correction.batchNo} · ${qty}${material.unit || ""} · 原流水 ${original.id}`,
        createdAt,
      });
      await writeState(state);
      return { movement: correction, original, state: serializePublicState(state) };
    },
  };
}

async function createPostgresStore() {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
  await ensureSchema(pool);
  await seedIfNeeded(pool);
  await migrateLegacyInventory(pool);

  return {
    kind: "postgres",
    async findUser(username, password) {
      const result = await pool.query("select id, name, role from app_users where username=$1 and password=$2 limit 1", [username, password]);
      return result.rows[0] || null;
    },
    async getState(role = "manager") {
      return serializeStateForRole(await readPostgresState(pool), role);
    },
    async createSample(input) {
      const state = await readPostgresState(pool);
      const sample = normalizeSampleInput(input);
      assertSampleInput(sample);
      const next = {
        id: input.id?.trim() || makeBusinessId("SP", state.samples.map((item) => item.id)),
        ...sample,
      };
      await pool.query("insert into samples(id,name,customer,version,owner,due_date,status) values($1,$2,$3,$4,$5,$6,$7)", [
        next.id,
        next.name,
        next.customer,
        next.version,
        next.owner,
        next.dueDate,
        next.status,
      ]);
      await pool.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
        makeId("act"),
        `${next.id} 已新建`,
        `${input.operator} · 刚刚`,
        `${next.name} / ${next.customer || "未填写客户"} · ${next.status}`,
        new Date().toISOString(),
      ]);
      return { sample: next, state: serializePublicState(await readPostgresState(pool)) };
    },
    async updateSample(sampleId, input) {
      const existing = await pool.query('select id, name, customer, version, owner, due_date as "dueDate", status from samples where id=$1 limit 1', [sampleId]);
      const sample = existing.rows[0];
      if (!sample) throw new Error("样品单不存在");
      const next = normalizeSampleInput(input, sample);
      assertSampleInput(next);
      await pool.query("update samples set name=$1, customer=$2, version=$3, owner=$4, due_date=$5, status=$6 where id=$7", [
        next.name,
        next.customer,
        next.version,
        next.owner,
        next.dueDate,
        next.status,
        sampleId,
      ]);
      await pool.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
        makeId("act"),
        `${sampleId} 已更新`,
        `${input.operator} · 刚刚`,
        `${next.name} / ${next.version || "未填写版本"} / ${next.status}`,
        new Date().toISOString(),
      ]);
      return { sample: { id: sampleId, ...next }, state: serializePublicState(await readPostgresState(pool)) };
    },
    async createWorkOrder(input) {
      const state = await readPostgresState(pool);
      const order = normalizeOrderInput(input);
      assertOrderInput(order);
      const next = {
        id: input.id?.trim() || makeBusinessId("WO", state.workOrders.map((item) => item.id)),
        ...order,
      };
      await pool.query(
        "insert into work_orders(id,sample_id,product,planned_qty,done_qty,current_process,priority,status,due_at,route) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [next.id, next.sampleId, next.product, next.plannedQty, next.doneQty, next.currentProcess, next.priority, next.status, next.dueAt, JSON.stringify(next.route)]
      );
      await pool.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
        makeId("act"),
        `${next.id} 已新建`,
        `${input.operator} · 刚刚`,
        `${next.product} · ${next.plannedQty} 双 · ${next.currentProcess}`,
        new Date().toISOString(),
      ]);
      return { workOrder: next, state: serializePublicState(await readPostgresState(pool)) };
    },
    async updateWorkOrder(workOrderId, input) {
      const existing = await pool.query(
        'select id, sample_id as "sampleId", product, planned_qty as "plannedQty", done_qty as "doneQty", current_process as "currentProcess", priority, status, due_at as "dueAt", route from work_orders where id=$1 limit 1',
        [workOrderId]
      );
      const order = existing.rows[0];
      if (!order) throw new Error("工单不存在");
      const next = normalizeOrderInput(input, order);
      assertOrderInput(next);
      await pool.query(
        "update work_orders set sample_id=$1, product=$2, planned_qty=$3, done_qty=$4, current_process=$5, priority=$6, status=$7, due_at=$8, route=$9 where id=$10",
        [next.sampleId, next.product, next.plannedQty, next.doneQty, next.currentProcess, next.priority, next.status, next.dueAt, JSON.stringify(next.route), workOrderId]
      );
      await pool.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
        makeId("act"),
        `${workOrderId} 已更新`,
        `${input.operator} · 刚刚`,
        `${next.product} · ${next.status} · ${next.currentProcess}`,
        new Date().toISOString(),
      ]);
      return { workOrder: { id: workOrderId, ...next }, state: serializePublicState(await readPostgresState(pool)) };
    },
    async createReport(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const orderResult = await client.query("select * from work_orders where id=$1 for update", [input.workOrderId]);
        const orderRow = orderResult.rows[0];
        if (!orderRow) throw new Error("工单不存在");
        const order = {
          id: orderRow.id,
          plannedQty: Number(orderRow.planned_qty || 0),
          doneQty: Number(orderRow.done_qty || 0),
          currentProcess: orderRow.current_process,
          status: orderRow.status,
          route: orderRow.route,
        };
        const normalized = normalizeReportInput(input, order);
        const existingReports = (
          await client.query(
            'select work_order_id as "workOrderId", process_name as "processName", completed_qty as "completedQty", good_qty as "goodQty", bad_qty as "badQty" from reports where work_order_id=$1',
            [order.id]
          )
        ).rows;
        assertReportInput(normalized, order, existingReports);
        const report = {
          id: makeId("rep"),
          ...normalized,
          createdAt: new Date().toISOString(),
        };
        await client.query(
          "insert into reports(id, work_order_id, process_name, completed_qty, good_qty, bad_qty, bad_reason, note, operator, created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            report.id,
            report.workOrderId,
            report.processName,
            report.completedQty,
            report.goodQty,
            report.badQty,
            report.badReason,
            report.note,
            report.operator,
            report.createdAt,
          ]
        );
        applyReportProgress(order, existingReports, report);
        await client.query(
          "update work_orders set done_qty=$1, current_process=$2, status=$3, route=$4 where id=$5",
          [order.doneQty, order.currentProcess, order.status, JSON.stringify(order.route), order.id]
        );
        await client.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
          makeId("act"),
          `${order.id} 提交${report.processName}报工`,
          `${input.operator} · 刚刚`,
          `完成 ${report.completedQty}，良品 ${report.goodQty}，不良 ${report.badQty}${report.badReason ? `，${report.badReason}` : ""}`,
          report.createdAt,
        ]);
        if (report.badQty > 0 || report.note) {
          await client.query("insert into alerts(id,title,text,severity,status,created_at) values($1,$2,$3,$4,$5,$6)", [
            makeId("al"),
            `${order.id} 现场异常`,
            `${report.processName}：${report.badReason || report.note || `不良 ${report.badQty}`}`,
            report.badQty > 0 ? "high" : "medium",
            "open",
            report.createdAt,
          ]);
        }
        await client.query("commit");
        return { report, state: serializePublicState(await readPostgresState(pool)) };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async createMaterialItem(input) {
      const existing = await readPostgresState(pool);
      const material = normalizeMaterialItemRecord(input);
      assertMaterialItemInput(material, existing.materialItems);
      await pool.query(
        "insert into material_items(code,name,spec,unit,safety_qty,default_location,supplier,status,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [material.code, material.name, material.spec, material.unit, material.safetyQty, material.defaultLocation, material.supplier, material.status, material.createdAt, material.updatedAt]
      );
      await pool.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
        makeId("act"),
        `${material.code} 物料已建档`,
        `${input.operator} · 刚刚`,
        `${material.name} / ${material.unit} / 安全库存 ${material.safetyQty}${material.unit}`,
        material.createdAt,
      ]);
      return { material, state: serializePublicState(await readPostgresState(pool)) };
    },
    async updateMaterialItem(materialCode, input) {
      const existing = await pool.query(
        'select code, name, spec, unit, safety_qty as "safetyQty", default_location as "defaultLocation", supplier, status, created_at as "createdAt", updated_at as "updatedAt" from material_items where code=$1 limit 1',
        [materialCode]
      );
      const current = existing.rows[0];
      if (!current) throw new Error("物料档案不存在");
      const state = await readPostgresState(pool);
      const next = {
        ...current,
        ...normalizeMaterialItemInput({ ...input, code: materialCode }, current),
        updatedAt: new Date().toISOString(),
      };
      assertMaterialItemInput(next, state.materialItems, materialCode);
      await pool.query(
        "update material_items set name=$1, spec=$2, unit=$3, safety_qty=$4, default_location=$5, supplier=$6, status=$7, updated_at=$8 where code=$9",
        [next.name, next.spec, next.unit, next.safetyQty, next.defaultLocation, next.supplier, next.status, next.updatedAt, materialCode]
      );
      await pool.query(
        "update materials set name=$1, spec=$2, unit=$3, safety_qty=$4 where code=$5",
        [next.name, next.spec, next.unit, next.safetyQty, materialCode]
      );
      await pool.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
        makeId("act"),
        `${materialCode} 物料已更新`,
        `${input.operator} · 刚刚`,
        `${next.name} / ${next.unit} / 安全库存 ${next.safetyQty}${next.unit}`,
        next.updatedAt,
      ]);
      return { material: next, state: serializePublicState(await readPostgresState(pool)) };
    },
    async createMaterialBatch(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const materialRows = await client.query('select code, name, spec, unit, safety_qty as "safetyQty", default_location as "defaultLocation", supplier, status, created_at as "createdAt", updated_at as "updatedAt" from material_items order by code');
        const batchRows = await client.query('select id, material_code as "materialCode", batch_no as "batchNo", initial_qty as "initialQty", stock_qty as "stockQty", location, received_date as "receivedDate", expiry_date as "expiryDate", supplier, note, created_at as "createdAt", updated_at as "updatedAt" from material_batches order by material_code, batch_no');
        const materialItems = materialRows.rows.map((item) => ({ ...item, safetyQty: Number(item.safetyQty) }));
        const materialBatches = batchRows.rows.map((item) => ({ ...item, initialQty: Number(item.initialQty), stockQty: Number(item.stockQty) }));
        const material = materialItems.find((item) => item.code === input.materialCode);
        const batch = normalizeMaterialBatchRecord(input, material);
        assertMaterialBatchInput(batch, materialItems, materialBatches);
        const movement = {
          id: makeId("stk"),
          materialCode: batch.materialCode,
          batchNo: batch.batchNo,
          type: "in",
          qty: batch.initialQty,
          location: batch.location,
          note: batch.note || "新建批次入库",
          operator: input.operator,
          source: "admin",
          beforeQty: 0,
          afterQty: batch.stockQty,
          materialBatchId: batch.id,
          createdAt: new Date().toISOString(),
        };
        await client.query(
          "insert into material_batches(id,material_code,batch_no,initial_qty,stock_qty,location,received_date,expiry_date,supplier,note,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [batch.id, batch.materialCode, batch.batchNo, batch.initialQty, batch.stockQty, batch.location, batch.receivedDate, batch.expiryDate, batch.supplier, batch.note, batch.createdAt, batch.updatedAt]
        );
        await client.query(
          "insert into materials(code,name,spec,stock_qty,safety_qty,unit,location,batch_no,expiry_date) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(code,batch_no) do update set name=excluded.name,spec=excluded.spec,stock_qty=excluded.stock_qty,safety_qty=excluded.safety_qty,unit=excluded.unit,location=excluded.location,expiry_date=excluded.expiry_date",
          [material.code, material.name, material.spec, batch.stockQty, material.safetyQty, material.unit, batch.location, batch.batchNo, batch.expiryDate]
        );
        await client.query(
          "insert into stock_movements(id, material_code, batch_no, type, qty, location, note, operator, source, before_qty, after_qty, material_batch_id, created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [movement.id, movement.materialCode, movement.batchNo, movement.type, movement.qty, movement.location, movement.note, movement.operator, movement.source, movement.beforeQty, movement.afterQty, movement.materialBatchId, movement.createdAt]
        );
        await client.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
          makeId("act"),
          `${material.name} 新批次入库`,
          `${input.operator} · 刚刚`,
          `${batch.batchNo} · ${batch.initialQty}${material.unit} · ${batch.location}`,
          movement.createdAt,
        ]);
        await client.query("commit");
        return { batch, movement, state: serializePublicState(await readPostgresState(pool)) };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async getFefoRecommendation(materialCode, qty, options = {}) {
      const state = await readPostgresState(pool);
      return buildFefoIssuePlan(materialCode, qty, state, options);
    },
    async getWorkOrderMaterialIssues(workOrderId) {
      const orderResult = await pool.query("select id from work_orders where id=$1 limit 1", [workOrderId]);
      if (!orderResult.rows[0]) throw new Error("工单不存在");
      const state = await readPostgresState(pool);
      const issues = enrichWorkOrderMaterialIssues(state.workOrderMaterialIssues, state.stockMovements)
        .filter((item) => item.workOrderId === workOrderId);
      return { issues };
    },
    async getMaterialBatchWorkOrderIssues(batchId) {
      const id = requireMaterialBatchId(batchId);
      const result = await pool.query(
        `select
           batch.id as "batchId",
           batch.material_code as "batchMaterialCode",
           batch.batch_no as "batchNo",
           batch.initial_qty as "initialQty",
           batch.stock_qty as "stockQty",
           batch.location as "batchLocation",
           batch.received_date as "receivedDate",
           batch.expiry_date as "expiryDate",
           batch.supplier as "batchSupplier",
           batch.note as "batchNote",
           batch.created_at as "batchCreatedAt",
           batch.updated_at as "batchUpdatedAt",
           material.code as "materialCode",
           material.name as "materialName",
           material.spec as "materialSpec",
           material.unit as "materialUnit",
           material.safety_qty as "materialSafetyQty",
           material.default_location as "materialDefaultLocation",
           material.supplier as "materialSupplier",
           material.status as "materialStatus",
           issue.id as "issueId",
           issue.work_order_id as "workOrderId",
           issue.material_code as "issueMaterialCode",
           issue.material_name as "issueMaterialName",
           issue.material_batch_id as "issueMaterialBatchId",
           issue.batch_no as "issueBatchNo",
           issue.qty as "issueQty",
           issue.unit as "issueUnit",
           issue.location as "issueLocation",
           issue.operator as "issueOperator",
           issue.source as "issueSource",
           issue.recommended_batch_no as "recommendedBatchNo",
           issue.is_fefo_recommended as "isFefoRecommended",
           issue.override_reason as "overrideReason",
           issue.stock_movement_id as "stockMovementId",
           issue.note as "issueNote",
           issue.created_at as "issueCreatedAt",
           original.id as "originalMovementId",
           original.material_code as "originalMaterialCode",
           original.batch_no as "originalBatchNo",
           original.type as "originalType",
           original.qty as "originalQty",
           original.location as "originalLocation",
           original.note as "originalNote",
           original.operator as "originalOperator",
           original.source as "originalSource",
           original.before_qty as "originalBeforeQty",
           original.after_qty as "originalAfterQty",
           original.material_batch_id as "originalMaterialBatchId",
           original.correction_of_movement_id as "originalCorrectionOfMovementId",
           original.corrected_by_movement_id as "originalCorrectedByMovementId",
           original.correction_reason as "originalCorrectionReason",
           original.corrected_at as "originalCorrectedAt",
           original.created_at as "originalCreatedAt",
           correction.id as "correctionMovementId",
           correction.material_code as "correctionMaterialCode",
           correction.batch_no as "correctionBatchNo",
           correction.type as "correctionType",
           correction.qty as "correctionQty",
           correction.location as "correctionLocation",
           correction.note as "correctionNote",
           correction.operator as "correctionOperator",
           correction.source as "correctionSource",
           correction.before_qty as "correctionBeforeQty",
           correction.after_qty as "correctionAfterQty",
           correction.material_batch_id as "correctionMaterialBatchId",
           correction.correction_of_movement_id as "correctionOfMovementId",
           correction.corrected_by_movement_id as "correctionCorrectedByMovementId",
           correction.correction_reason as "correctionReason",
           correction.corrected_at as "correctionCorrectedAt",
           correction.created_at as "correctionCreatedAt",
           work_order.id as "orderId",
           work_order.product as "orderProduct",
           work_order.planned_qty as "orderPlannedQty",
           work_order.done_qty as "orderDoneQty",
           work_order.current_process as "orderCurrentProcess",
           work_order.priority as "orderPriority",
           work_order.status as "orderStatus",
           work_order.due_at as "orderDueAt",
           work_order.route as "orderRoute"
         from material_batches batch
         left join material_items material on material.code = batch.material_code
         left join work_order_material_issues issue on (
           issue.material_batch_id = batch.id
           or (nullif(issue.material_batch_id, '') is null and issue.material_code = batch.material_code and issue.batch_no = batch.batch_no)
         )
         left join stock_movements original on original.id = issue.stock_movement_id
         left join stock_movements correction on correction.id = original.corrected_by_movement_id
         left join work_orders work_order on work_order.id = issue.work_order_id
         where batch.id = $1
         order by issue.created_at desc nulls last, issue.id desc`,
        [id]
      );
      if (!result.rows.length) throw createStoreError("NOT_FOUND", "物料批次不存在");

      const first = result.rows[0];
      const batch = {
        id: first.batchId,
        materialCode: first.batchMaterialCode,
        batchNo: first.batchNo,
        initialQty: Number(first.initialQty || 0),
        stockQty: Number(first.stockQty || 0),
        location: first.batchLocation,
        receivedDate: first.receivedDate,
        expiryDate: first.expiryDate,
        supplier: first.batchSupplier,
        note: first.batchNote,
        createdAt: first.batchCreatedAt,
        updatedAt: first.batchUpdatedAt,
      };
      const material = {
        code: first.materialCode || first.batchMaterialCode,
        name: first.materialName || first.batchMaterialCode,
        spec: first.materialSpec || "",
        unit: first.materialUnit || "",
        safetyQty: toOptionalNumber(first.materialSafetyQty),
        defaultLocation: first.materialDefaultLocation || "",
        supplier: first.materialSupplier || "",
        status: first.materialStatus || "",
      };
      const workOrdersById = new Map();
      const issues = result.rows
        .filter((row) => row.issueId)
        .map((row) => {
          const workOrder = row.orderId
            ? {
                id: row.orderId,
                product: row.orderProduct,
                plannedQty: row.orderPlannedQty,
                doneQty: row.orderDoneQty,
                currentProcess: row.orderCurrentProcess,
                priority: row.orderPriority,
                status: row.orderStatus,
                dueAt: row.orderDueAt,
                route: row.orderRoute,
              }
            : null;
          if (workOrder && !workOrdersById.has(workOrder.id)) workOrdersById.set(workOrder.id, workOrder);
          const originalMovement = row.originalMovementId
            ? {
                id: row.originalMovementId,
                materialCode: row.originalMaterialCode,
                batchNo: row.originalBatchNo,
                type: row.originalType,
                qty: row.originalQty,
                location: row.originalLocation,
                note: row.originalNote,
                operator: row.originalOperator,
                source: row.originalSource,
                beforeQty: row.originalBeforeQty,
                afterQty: row.originalAfterQty,
                materialBatchId: row.originalMaterialBatchId,
                correctionOfMovementId: row.originalCorrectionOfMovementId,
                correctedByMovementId: row.originalCorrectedByMovementId,
                correctionReason: row.originalCorrectionReason,
                correctedAt: row.originalCorrectedAt,
                createdAt: row.originalCreatedAt,
              }
            : null;
          const correctionMovement = row.correctionMovementId
            ? {
                id: row.correctionMovementId,
                materialCode: row.correctionMaterialCode,
                batchNo: row.correctionBatchNo,
                type: row.correctionType,
                qty: row.correctionQty,
                location: row.correctionLocation,
                note: row.correctionNote,
                operator: row.correctionOperator,
                source: row.correctionSource,
                beforeQty: row.correctionBeforeQty,
                afterQty: row.correctionAfterQty,
                materialBatchId: row.correctionMaterialBatchId,
                correctionOfMovementId: row.correctionOfMovementId,
                correctedByMovementId: row.correctionCorrectedByMovementId,
                correctionReason: row.correctionReason,
                correctedAt: row.correctionCorrectedAt,
                createdAt: row.correctionCreatedAt,
              }
            : null;
          return {
            id: row.issueId,
            workOrderId: row.workOrderId,
            materialCode: row.issueMaterialCode || row.batchMaterialCode,
            materialName: row.issueMaterialName || first.materialName || row.batchMaterialCode,
            materialBatchId: row.issueMaterialBatchId || "",
            batchNo: row.issueBatchNo || row.batchNo,
            qty: row.issueQty,
            unit: row.issueUnit || first.materialUnit || "",
            location: row.issueLocation || "",
            operator: row.issueOperator || "",
            source: row.issueSource || "work_order_issue",
            recommendedBatchNo: row.recommendedBatchNo || "",
            isFefoRecommended: Boolean(row.isFefoRecommended),
            overrideReason: row.overrideReason || "",
            stockMovementId: row.stockMovementId || "",
            note: row.issueNote || "",
            createdAt: row.issueCreatedAt || "",
            stockMovement: originalMovement,
            correctionMovement,
            workOrder,
          };
        });
      return buildMaterialBatchWorkOrderTrace({
        batch,
        material,
        issues,
        workOrders: Array.from(workOrdersById.values()),
      });
    },
    async createWorkOrderMaterialIssue(workOrderId, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const orderResult = await client.query("select id, product, status from work_orders where id=$1 for update", [workOrderId]);
        const order = orderResult.rows[0];
        if (!order) throw new Error("工单不存在");
        assertWorkOrderMaterialIssueStatus(order);

        const issueInput = normalizeWorkOrderMaterialIssueInput(workOrderId, input);
        if (!issueInput.operator) throw new Error("操作人不能为空");
        const materialResult = await client.query("select code, name, unit, safety_qty from material_items where code=$1 limit 1", [issueInput.materialCode]);
        const material = materialResult.rows[0];
        if (!material) throw new Error("物料档案不存在");
        const batchResult = await client.query(
          "select * from material_batches where material_code=$1 and batch_no=$2 for update",
          [issueInput.materialCode, issueInput.batchNo]
        );
        const batchRow = batchResult.rows[0];
        if (!batchRow) throw new Error("物料批次不存在或不属于所选物料");
        const batch = {
          id: batchRow.id,
          materialCode: batchRow.material_code,
          batchNo: batchRow.batch_no,
          stockQty: Number(batchRow.stock_qty || 0),
          location: batchRow.location,
          receivedDate: batchRow.received_date,
          expiryDate: batchRow.expiry_date,
        };
        const movementInput = { ...issueInput, type: "out" };
        assertStockMovementInput(movementInput, batch.stockQty);
        const stateForFefo = await readPostgresState(client);
        const fefoPlan = assertFefoStockMovement(movementInput, batch, stateForFefo);
        const beforeQty = batch.stockQty;
        const afterQty = addDecimalQuantities(beforeQty, -movementInput.qty);
        const createdAt = new Date().toISOString();
        const movement = {
          id: makeId("stk"),
          materialCode: batch.materialCode,
          batchNo: batch.batchNo,
          type: "out",
          qty: movementInput.qty,
          location: movementInput.location || batch.location,
          note: [movementInput.note, movementInput.overrideReason ? `FEFO原因：${movementInput.overrideReason}` : ""].filter(Boolean).join("；"),
          operator: issueInput.operator,
          source: "work_order_issue",
          beforeQty,
          afterQty,
          materialBatchId: batch.id,
          overrideReason: movementInput.overrideReason,
          recommendedBatchNo: fefoPlan?.recommendedBatch?.batchNo || "",
          createdAt,
        };
        const issue = buildWorkOrderMaterialIssue({ order, material, batch, movement, fefoPlan, input: issueInput });

        await client.query("update material_batches set stock_qty=$1, location=$2, updated_at=$3 where material_code=$4 and batch_no=$5", [
          afterQty,
          movement.location,
          createdAt,
          movement.materialCode,
          movement.batchNo,
        ]);
        await client.query("update materials set stock_qty=$1, location=$2 where code=$3 and batch_no=$4", [
          afterQty,
          movement.location,
          movement.materialCode,
          movement.batchNo,
        ]);
        await client.query(
          "insert into stock_movements(id, material_code, batch_no, type, qty, location, note, operator, source, before_qty, after_qty, material_batch_id, created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [movement.id, movement.materialCode, movement.batchNo, movement.type, movement.qty, movement.location, movement.note, movement.operator, movement.source, movement.beforeQty, movement.afterQty, movement.materialBatchId, movement.createdAt]
        );
        await client.query(
          "insert into work_order_material_issues(id,work_order_id,material_code,material_name,material_batch_id,batch_no,qty,unit,location,operator,source,recommended_batch_no,is_fefo_recommended,override_reason,stock_movement_id,note,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
          [issue.id, issue.workOrderId, issue.materialCode, issue.materialName, issue.materialBatchId, issue.batchNo, issue.qty, issue.unit, issue.location, issue.operator, issue.source, issue.recommendedBatchNo, issue.isFefoRecommended, issue.overrideReason, issue.stockMovementId, issue.note, issue.createdAt]
        );
        await client.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
          makeId("act"),
          `${order.id} 工单领料`,
          `${issueInput.operator} · 刚刚`,
          `${material.name} / ${batch.batchNo} / ${movement.qty}${material.unit || ""}`,
          createdAt,
        ]);
        await client.query("commit");
        return { issue, movement, state: serializePublicState(await readPostgresState(pool)) };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async createStockMovement(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const movementInput = normalizeStockMovementInput(input);
        const result = await client.query(
          "select * from material_batches where material_code=$1 and batch_no=$2 for update",
          [movementInput.materialCode, movementInput.batchNo]
        );
        const batch = result.rows[0];
        if (!batch) throw new Error("物料批次不存在");
        const materialResult = await client.query(
          "select name, spec, unit, safety_qty from material_items where code=$1 limit 1",
          [movementInput.materialCode]
        );
        const material = materialResult.rows[0] || {};
        assertStockMovementInput(movementInput, batch.stock_qty);
        const stateForFefo = await readPostgresState(pool);
        const selectedBatchForFefo = (stateForFefo.materialBatches || []).find((item) => item.materialCode === movementInput.materialCode && item.batchNo === movementInput.batchNo) || {
          materialCode: batch.material_code,
          batchNo: batch.batch_no,
          stockQty: Number(batch.stock_qty || 0),
          location: batch.location,
          receivedDate: batch.received_date,
          expiryDate: batch.expiry_date,
        };
        const fefoPlan = assertFefoStockMovement(movementInput, selectedBatchForFefo, stateForFefo);
        const qty = movementInput.qty;
        const sign = movementInput.type === "out" ? -1 : 1;
        const beforeQty = Number(batch.stock_qty);
        const nextQty = beforeQty + sign * qty;
        const movement = {
          id: makeId("stk"),
          materialCode: movementInput.materialCode,
          batchNo: movementInput.batchNo,
          type: movementInput.type,
          qty,
          location: movementInput.location || batch.location,
          note: [movementInput.note, movementInput.overrideReason ? `FEFO原因：${movementInput.overrideReason}` : ""].filter(Boolean).join("；"),
          operator: input.operator,
          source: input.source || "mobile",
          beforeQty,
          afterQty: nextQty,
          materialBatchId: batch.id,
          overrideReason: movementInput.overrideReason,
          recommendedBatchNo: fefoPlan?.recommendedBatch?.batchNo || "",
          createdAt: new Date().toISOString(),
        };
        await client.query("update material_batches set stock_qty=$1, location=$2, updated_at=$3 where material_code=$4 and batch_no=$5", [nextQty, movement.location, movement.createdAt, movementInput.materialCode, movementInput.batchNo]);
        await client.query("update materials set stock_qty=$1, location=$2 where code=$3 and batch_no=$4", [nextQty, movement.location, movementInput.materialCode, movementInput.batchNo]);
        await client.query(
          "insert into stock_movements(id, material_code, batch_no, type, qty, location, note, operator, source, before_qty, after_qty, material_batch_id, created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [movement.id, movement.materialCode, movement.batchNo, movement.type, movement.qty, movement.location, movement.note, movement.operator, movement.source, movement.beforeQty, movement.afterQty, movement.materialBatchId, movement.createdAt]
        );
        await client.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
          makeId("act"),
          `${material.name || movement.materialCode} ${movement.type === "out" ? "出库" : "入库"}`,
          `${input.operator} · 刚刚`,
          `${movement.batchNo} · ${qty}${material.unit || ""} · ${movement.location}`,
          movement.createdAt,
        ]);
        const totalResult = await client.query("select coalesce(sum(stock_qty),0)::numeric as total from material_batches where material_code=$1", [movementInput.materialCode]);
        const totalStockQty = Number(totalResult.rows[0].total || 0);
        if (totalStockQty < Number(material.safety_qty || 0)) {
          await client.query("insert into alerts(id,title,text,severity,status,created_at) values($1,$2,$3,$4,$5,$6)", [
            makeId("al"),
            `${material.name || movement.materialCode} 库存不足`,
            `${movementInput.materialCode} 当前 ${totalStockQty}${material.unit || ""}，低于安全库存 ${material.safety_qty || 0}${material.unit || ""}。`,
            "high",
            "open",
            movement.createdAt,
          ]);
        }
        await client.query("commit");
        return { movement, state: serializePublicState(await readPostgresState(pool)) };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async correctStockMovement(movementId, input = {}) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const movementResult = await client.query(
          'select id, material_code as "materialCode", batch_no as "batchNo", type, qty, location, note, operator, source, before_qty as "beforeQty", after_qty as "afterQty", material_batch_id as "materialBatchId", correction_of_movement_id as "correctionOfMovementId", corrected_by_movement_id as "correctedByMovementId", correction_reason as "correctionReason", corrected_at as "correctedAt", created_at as "createdAt" from stock_movements where id=$1 for update',
          [movementId]
        );
        const original = movementResult.rows[0];
        const batchResult = original
          ? await client.query("select * from material_batches where material_code=$1 and batch_no=$2 for update", [original.materialCode, original.batchNo])
          : { rows: [] };
        const batchRow = batchResult.rows[0];
        const batch = batchRow
          ? {
              id: batchRow.id,
              materialCode: batchRow.material_code,
              batchNo: batchRow.batch_no,
              stockQty: Number(batchRow.stock_qty || 0),
              location: batchRow.location,
            }
          : null;
        const reason = String(input.correctionReason || input.reason || "").trim();
        assertCorrectionInput(original, batch, reason);
        const materialResult = await client.query("select name, unit, safety_qty from material_items where code=$1 limit 1", [original.materialCode]);
        const material = materialResult.rows[0] || {};
        const type = original.type === "in" ? "out" : "in";
        const qty = Number(original.qty || 0);
        const beforeQty = Number(batch.stockQty || 0);
        const afterQty = original.type === "in" ? beforeQty - qty : beforeQty + qty;
        const createdAt = new Date().toISOString();
        const correction = {
          id: makeId("stk"),
          materialCode: original.materialCode,
          batchNo: original.batchNo,
          type,
          qty,
          location: original.location || batch.location,
          note: `冲正 ${original.id}：${reason}`,
          operator: input.operator,
          source: "correction",
          beforeQty,
          afterQty,
          materialBatchId: original.materialBatchId || batch.id,
          correctionOfMovementId: original.id,
          correctionReason: reason,
          createdAt,
        };
        await client.query("update material_batches set stock_qty=$1, location=$2, updated_at=$3 where material_code=$4 and batch_no=$5", [
          afterQty,
          correction.location,
          createdAt,
          original.materialCode,
          original.batchNo,
        ]);
        await client.query("update materials set stock_qty=$1, location=$2 where code=$3 and batch_no=$4", [afterQty, correction.location, original.materialCode, original.batchNo]);
        await client.query(
          "insert into stock_movements(id, material_code, batch_no, type, qty, location, note, operator, source, before_qty, after_qty, material_batch_id, correction_of_movement_id, correction_reason, created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
          [
            correction.id,
            correction.materialCode,
            correction.batchNo,
            correction.type,
            correction.qty,
            correction.location,
            correction.note,
            correction.operator,
            correction.source,
            correction.beforeQty,
            correction.afterQty,
            correction.materialBatchId,
            correction.correctionOfMovementId,
            correction.correctionReason,
            correction.createdAt,
          ]
        );
        await client.query("update stock_movements set corrected_by_movement_id=$1, correction_reason=$2, corrected_at=$3 where id=$4", [
          correction.id,
          reason,
          createdAt,
          original.id,
        ]);
        await client.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
          makeId("act"),
          `${material.name || correction.materialCode} ${movementTypeLabel(original.type)}已冲正`,
          `${input.operator} · 刚刚`,
          `${correction.batchNo} · ${qty}${material.unit || ""} · 原流水 ${original.id}`,
          createdAt,
        ]);
        await client.query("commit");
        return { movement: correction, original, state: serializePublicState(await readPostgresState(pool)) };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function ensureSchema(pool) {
  await pool.query(`
    create table if not exists app_users (
      id text primary key,
      username text unique not null,
      password text not null,
      name text not null,
      role text not null,
      created_at timestamptz default now()
    );
    create table if not exists samples (
      id text primary key,
      name text not null,
      customer text,
      version text,
      owner text,
      due_date date,
      status text not null
    );
    create table if not exists work_orders (
      id text primary key,
      sample_id text,
      product text not null,
      planned_qty integer not null,
      done_qty integer not null default 0,
      current_process text,
      priority text,
      status text not null,
      due_at text,
      route jsonb not null default '[]'::jsonb
    );
    create table if not exists materials (
      code text not null,
      name text not null,
      spec text,
      stock_qty numeric not null default 0,
      safety_qty numeric not null default 0,
      unit text,
      location text,
      batch_no text not null,
      expiry_date date,
      primary key(code, batch_no)
    );
    create table if not exists material_items (
      code text primary key,
      name text not null,
      spec text,
      unit text not null,
      safety_qty numeric not null default 0,
      default_location text,
      supplier text,
      status text not null default '启用',
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create table if not exists material_batches (
      id text primary key,
      material_code text not null references material_items(code),
      batch_no text not null,
      initial_qty numeric not null default 0,
      stock_qty numeric not null default 0,
      location text not null,
      received_date date not null,
      expiry_date date not null,
      supplier text,
      note text,
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      unique(material_code, batch_no)
    );
    create table if not exists reports (
      id text primary key,
      work_order_id text not null,
      process_name text not null,
      completed_qty integer not null default 0,
      good_qty integer not null default 0,
      bad_qty integer not null default 0,
      bad_reason text,
      note text,
      operator text,
      created_at timestamptz default now()
    );
    create table if not exists stock_movements (
      id text primary key,
      material_code text not null,
      batch_no text not null,
      type text not null,
      qty numeric not null,
      location text,
      note text,
      operator text,
      created_at timestamptz default now()
    );
    create table if not exists work_order_material_issues (
      id text primary key,
      work_order_id text not null references work_orders(id),
      material_code text not null,
      material_name text not null,
      material_batch_id text not null references material_batches(id),
      batch_no text not null,
      qty numeric not null,
      unit text not null,
      location text,
      operator text not null,
      source text not null default 'work_order_issue',
      recommended_batch_no text,
      is_fefo_recommended boolean not null default false,
      override_reason text,
      stock_movement_id text not null unique references stock_movements(id),
      note text,
      created_at timestamptz default now()
    );
    create table if not exists activities (
      id text primary key,
      title text not null,
      meta text,
      note text,
      created_at timestamptz default now()
    );
    create table if not exists alerts (
      id text primary key,
      title text not null,
      text text,
      severity text,
      status text not null default 'open',
      created_at timestamptz default now()
    );
  `);
  await pool.query("alter table reports add column if not exists completed_qty integer not null default 0");
  await pool.query("alter table reports add column if not exists bad_reason text");
  await pool.query("alter table stock_movements add column if not exists source text");
  await pool.query("alter table stock_movements add column if not exists before_qty numeric");
  await pool.query("alter table stock_movements add column if not exists after_qty numeric");
  await pool.query("alter table stock_movements add column if not exists material_batch_id text");
  await pool.query("alter table stock_movements add column if not exists correction_of_movement_id text");
  await pool.query("alter table stock_movements add column if not exists corrected_by_movement_id text");
  await pool.query("alter table stock_movements add column if not exists correction_reason text");
  await pool.query("alter table stock_movements add column if not exists corrected_at timestamptz");
  await pool.query("create index if not exists work_order_material_issues_work_order_idx on work_order_material_issues(work_order_id)");
  await pool.query("create index if not exists work_order_material_issues_material_idx on work_order_material_issues(material_code)");
  await pool.query("create index if not exists work_order_material_issues_batch_idx on work_order_material_issues(material_batch_id)");
}

async function migrateLegacyInventory(pool) {
  const legacy = await pool.query('select code, name, spec, stock_qty as "stockQty", safety_qty as "safetyQty", unit, location, batch_no as "batchNo", expiry_date as "expiryDate" from materials order by code');
  for (const row of legacy.rows) {
    if (!row.code) continue;
    const material = normalizeMaterialItemRecord({
      code: row.code,
      name: row.name,
      spec: row.spec,
      unit: row.unit,
      safetyQty: Number(row.safetyQty || 0),
      defaultLocation: row.location,
      status: "启用",
    });
    await pool.query(
      "insert into material_items(code,name,spec,unit,safety_qty,default_location,supplier,status,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(code) do nothing",
      [material.code, material.name, material.spec, material.unit, material.safetyQty, material.defaultLocation, material.supplier, material.status, material.createdAt, material.updatedAt]
    );
    if (!row.batchNo) continue;
    const batch = normalizeMaterialBatchRecord({
      id: `legacy-${row.code}-${row.batchNo}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
      materialCode: row.code,
      batchNo: row.batchNo,
      initialQty: Number(row.stockQty || 0),
      stockQty: Number(row.stockQty || 0),
      location: row.location || material.defaultLocation || "历史库存",
      receivedDate: dateOnly(new Date()),
      expiryDate: row.expiryDate || "2099-12-31",
      note: "历史库存迁移",
    }, material);
    await pool.query(
      "insert into material_batches(id,material_code,batch_no,initial_qty,stock_qty,location,received_date,expiry_date,supplier,note,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(material_code,batch_no) do nothing",
      [batch.id, batch.materialCode, batch.batchNo, batch.initialQty, batch.stockQty, batch.location, batch.receivedDate, batch.expiryDate, batch.supplier, batch.note, batch.createdAt, batch.updatedAt]
    );
  }
}

async function seedIfNeeded(pool) {
  const result = await pool.query("select count(*)::int as count from app_users");
  if (result.rows[0].count > 0) return;
  for (const user of seedData.users) {
    await pool.query("insert into app_users(id,username,password,name,role) values($1,$2,$3,$4,$5)", [user.id, user.username, user.password, user.name, user.role]);
  }
  for (const sample of seedData.samples) {
    await pool.query("insert into samples(id,name,customer,version,owner,due_date,status) values($1,$2,$3,$4,$5,$6,$7)", [sample.id, sample.name, sample.customer, sample.version, sample.owner, sample.dueDate, sample.status]);
  }
  for (const order of seedData.workOrders) {
    await pool.query(
      "insert into work_orders(id,sample_id,product,planned_qty,done_qty,current_process,priority,status,due_at,route) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [order.id, order.sampleId, order.product, order.plannedQty, order.doneQty, order.currentProcess, order.priority, order.status, order.dueAt, JSON.stringify(order.route)]
    );
  }
  for (const material of seedData.materials) {
    await pool.query(
      "insert into materials(code,name,spec,stock_qty,safety_qty,unit,location,batch_no,expiry_date) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [material.code, material.name, material.spec, material.stockQty, material.safetyQty, material.unit, material.location, material.batchNo, material.expiryDate]
    );
  }
  for (const item of seedData.activities) {
    await pool.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [item.id, item.title, item.meta, item.note, item.createdAt]);
  }
  for (const item of seedData.alerts) {
    await pool.query("insert into alerts(id,title,text,severity,status,created_at) values($1,$2,$3,$4,$5,$6)", [item.id, item.title, item.text, item.severity, item.status, item.createdAt]);
  }
}

async function readPostgresState(pool) {
  const [users, samples, workOrders, materialItems, materialBatches, reports, stockMovements, workOrderMaterialIssues, activities, alerts] = await Promise.all([
    pool.query("select id, username, name, role from app_users order by created_at"),
    pool.query("select id, name, customer, version, owner, due_date as \"dueDate\", status from samples order by id"),
    pool.query('select id, sample_id as "sampleId", product, planned_qty as "plannedQty", done_qty as "doneQty", current_process as "currentProcess", priority, status, due_at as "dueAt", route from work_orders order by id'),
    pool.query('select code, name, spec, unit, safety_qty as "safetyQty", default_location as "defaultLocation", supplier, status, created_at as "createdAt", updated_at as "updatedAt" from material_items order by code'),
    pool.query('select id, material_code as "materialCode", batch_no as "batchNo", initial_qty as "initialQty", stock_qty as "stockQty", location, received_date as "receivedDate", expiry_date as "expiryDate", supplier, note, created_at as "createdAt", updated_at as "updatedAt" from material_batches order by material_code, batch_no'),
    pool.query(
      'select id, work_order_id as "workOrderId", process_name as "processName", completed_qty as "completedQty", good_qty as "goodQty", bad_qty as "badQty", bad_reason as "badReason", note, operator, created_at as "createdAt" from reports order by created_at desc limit 200'
    ),
    pool.query('select id, material_code as "materialCode", batch_no as "batchNo", type, qty, location, note, operator, source, before_qty as "beforeQty", after_qty as "afterQty", material_batch_id as "materialBatchId", correction_of_movement_id as "correctionOfMovementId", corrected_by_movement_id as "correctedByMovementId", correction_reason as "correctionReason", corrected_at as "correctedAt", created_at as "createdAt" from stock_movements order by created_at desc limit 100'),
    pool.query('select issue.id, issue.work_order_id as "workOrderId", issue.material_code as "materialCode", issue.material_name as "materialName", issue.material_batch_id as "materialBatchId", issue.batch_no as "batchNo", issue.qty, issue.unit, issue.location, issue.operator, issue.source, issue.recommended_batch_no as "recommendedBatchNo", issue.is_fefo_recommended as "isFefoRecommended", issue.override_reason as "overrideReason", issue.stock_movement_id as "stockMovementId", issue.note, issue.created_at as "createdAt", original.corrected_by_movement_id as "correctionMovementId", original.correction_reason as "correctionReason", original.corrected_at as "correctedAt", (original.corrected_by_movement_id is not null) as "isCorrected" from work_order_material_issues issue left join stock_movements original on original.id = issue.stock_movement_id order by issue.created_at desc limit 200'),
    pool.query('select id, title, meta, note, created_at as "createdAt" from activities order by created_at desc limit 50'),
    pool.query('select id, title, text, severity, status, created_at as "createdAt" from alerts order by created_at desc limit 50'),
  ]);
  return normalizeState({
    users: users.rows,
    samples: samples.rows,
    workOrders: workOrders.rows,
    materialItems: materialItems.rows.map((item) => ({ ...item, safetyQty: Number(item.safetyQty) })),
    materialBatches: materialBatches.rows.map((item) => ({ ...item, initialQty: Number(item.initialQty), stockQty: Number(item.stockQty) })),
    reports: reports.rows,
    stockMovements: stockMovements.rows.map((item) => ({
      ...item,
      qty: Number(item.qty),
      beforeQty: item.beforeQty === null || item.beforeQty === undefined ? undefined : Number(item.beforeQty),
      afterQty: item.afterQty === null || item.afterQty === undefined ? undefined : Number(item.afterQty),
    })),
    workOrderMaterialIssues: workOrderMaterialIssues.rows.map((item) => ({
      ...item,
      qty: Number(item.qty),
      isFefoRecommended: Boolean(item.isFefoRecommended),
      isCorrected: Boolean(item.isCorrected),
    })),
    activities: activities.rows,
    alerts: alerts.rows,
  });
}
