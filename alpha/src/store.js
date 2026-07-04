import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getProcessInputContext,
  getProcessReportSummary,
} from "../public/production-metrics.js";
import { seedData } from "./seed.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function normalizeState(data) {
  return {
    users: data.users || [],
    samples: data.samples || [],
    workOrders: data.workOrders || [],
    materials: data.materials || [],
    reports: data.reports || [],
    stockMovements: data.stockMovements || [],
    activities: data.activities || [],
    alerts: data.alerts || [],
  };
}

function serializePublicState(data) {
  const state = normalizeState(data);
  return {
    samples: state.samples,
    workOrders: state.workOrders,
    materials: state.materials,
    reports: state.reports,
    stockMovements: state.stockMovements,
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
    const stockMovements = state.stockMovements.slice(0, 30);
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
  if (process.env.DATABASE_URL) {
    try {
      return await createPostgresStore();
    } catch (error) {
      console.warn("PostgreSQL unavailable, falling back to file store:", error.message);
    }
  }
  return createFileStore(rootDir);
}

async function createFileStore(rootDir) {
  const dataDir = join(rootDir, "data");
  const dataFile = join(dataDir, "alpha-store.json");
  await mkdir(dataDir, { recursive: true });

  async function readState() {
    try {
      return normalizeState(JSON.parse(await readFile(dataFile, "utf8")));
    } catch {
      await writeFile(dataFile, JSON.stringify(seedData, null, 2), "utf8");
      return clone(seedData);
    }
  }

  async function writeState(state) {
    await writeFile(dataFile, JSON.stringify(state, null, 2), "utf8");
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
    async createStockMovement(input) {
      const state = await readState();
      const movementInput = normalizeStockMovementInput(input);
      const material = state.materials.find((item) => item.code === movementInput.materialCode && item.batchNo === movementInput.batchNo);
      if (!material) throw new Error("物料批次不存在");
      assertStockMovementInput(movementInput, material.stockQty);
      const qty = movementInput.qty;
      const sign = movementInput.type === "out" ? -1 : 1;
      const nextQty = Number(material.stockQty || 0) + sign * qty;
      material.stockQty = nextQty;
      if (movementInput.location) material.location = movementInput.location;
      const movement = {
        id: makeId("stk"),
        materialCode: movementInput.materialCode,
        batchNo: movementInput.batchNo,
        type: movementInput.type,
        qty,
        location: movementInput.location || material.location,
        note: movementInput.note,
        operator: input.operator,
        createdAt: new Date().toISOString(),
      };
      state.stockMovements.unshift(movement);
      state.activities.unshift({
        id: makeId("act"),
        title: `${material.name} ${movement.type === "out" ? "出库" : "入库"}`,
        meta: `${input.operator} · 刚刚`,
        note: `${movement.batchNo} · ${qty}${material.unit} · ${movement.location}`,
        createdAt: movement.createdAt,
      });
      if (nextQty < material.safetyQty) {
        state.alerts.unshift({
          id: makeId("al"),
          title: `${material.name} 库存不足`,
          text: `${material.code} 当前 ${material.stockQty}${material.unit}，低于安全库存 ${material.safetyQty}${material.unit}。`,
          severity: "high",
          status: "open",
          createdAt: movement.createdAt,
        });
      }
      await writeState(state);
      return { movement, state: serializePublicState(state) };
    },
  };
}

async function createPostgresStore() {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
  await ensureSchema(pool);
  await seedIfNeeded(pool);

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
    async createStockMovement(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const movementInput = normalizeStockMovementInput(input);
        const result = await client.query("select * from materials where code=$1 and batch_no=$2 for update", [movementInput.materialCode, movementInput.batchNo]);
        const material = result.rows[0];
        if (!material) throw new Error("物料批次不存在");
        assertStockMovementInput(movementInput, material.stock_qty);
        const qty = movementInput.qty;
        const sign = movementInput.type === "out" ? -1 : 1;
        const nextQty = Number(material.stock_qty) + sign * qty;
        const movement = {
          id: makeId("stk"),
          materialCode: movementInput.materialCode,
          batchNo: movementInput.batchNo,
          type: movementInput.type,
          qty,
          location: movementInput.location || material.location,
          note: movementInput.note,
          operator: input.operator,
          createdAt: new Date().toISOString(),
        };
        await client.query("update materials set stock_qty=$1, location=$2 where code=$3 and batch_no=$4", [nextQty, movement.location, movementInput.materialCode, movementInput.batchNo]);
        await client.query(
          "insert into stock_movements(id, material_code, batch_no, type, qty, location, note, operator, created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [movement.id, movement.materialCode, movement.batchNo, movement.type, movement.qty, movement.location, movement.note, movement.operator, movement.createdAt]
        );
        await client.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
          makeId("act"),
          `${material.name} ${movement.type === "out" ? "出库" : "入库"}`,
          `${input.operator} · 刚刚`,
          `${movement.batchNo} · ${qty}${material.unit} · ${movement.location}`,
          movement.createdAt,
        ]);
        if (nextQty < Number(material.safety_qty)) {
          await client.query("insert into alerts(id,title,text,severity,status,created_at) values($1,$2,$3,$4,$5,$6)", [
            makeId("al"),
            `${material.name} 库存不足`,
            `${material.code} 当前 ${nextQty}${material.unit}，低于安全库存 ${material.safety_qty}${material.unit}。`,
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
  const [users, samples, workOrders, materials, reports, stockMovements, activities, alerts] = await Promise.all([
    pool.query("select id, username, name, role from app_users order by created_at"),
    pool.query("select id, name, customer, version, owner, due_date as \"dueDate\", status from samples order by id"),
    pool.query('select id, sample_id as "sampleId", product, planned_qty as "plannedQty", done_qty as "doneQty", current_process as "currentProcess", priority, status, due_at as "dueAt", route from work_orders order by id'),
    pool.query('select code, name, spec, stock_qty as "stockQty", safety_qty as "safetyQty", unit, location, batch_no as "batchNo", expiry_date as "expiryDate" from materials order by code'),
    pool.query(
      'select id, work_order_id as "workOrderId", process_name as "processName", completed_qty as "completedQty", good_qty as "goodQty", bad_qty as "badQty", bad_reason as "badReason", note, operator, created_at as "createdAt" from reports order by created_at desc limit 200'
    ),
    pool.query('select id, material_code as "materialCode", batch_no as "batchNo", type, qty, location, note, operator, created_at as "createdAt" from stock_movements order by created_at desc limit 50'),
    pool.query('select id, title, meta, note, created_at as "createdAt" from activities order by created_at desc limit 50'),
    pool.query('select id, title, text, severity, status, created_at as "createdAt" from alerts order by created_at desc limit 50'),
  ]);
  return normalizeState({
    users: users.rows,
    samples: samples.rows,
    workOrders: workOrders.rows,
    materials: materials.rows.map((item) => ({ ...item, stockQty: Number(item.stockQty), safetyQty: Number(item.safetyQty) })),
    reports: reports.rows,
    stockMovements: stockMovements.rows,
    activities: activities.rows,
    alerts: alerts.rows,
  });
}
