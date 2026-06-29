import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seedData } from "./seed.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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
    async getState() {
      return serializePublicState(await readState());
    },
    async createReport(input) {
      const state = await readState();
      const order = state.workOrders.find((item) => item.id === input.workOrderId);
      if (!order) throw new Error("工单不存在");
      const goodQty = Number(input.goodQty || 0);
      const badQty = Number(input.badQty || 0);
      const report = {
        id: makeId("rep"),
        workOrderId: input.workOrderId,
        processName: input.processName || order.currentProcess,
        goodQty,
        badQty,
        note: input.note || "",
        operator: input.operator,
        createdAt: new Date().toISOString(),
      };
      order.doneQty = Math.min(order.plannedQty, Number(order.doneQty || 0) + goodQty);
      state.reports.unshift(report);
      state.activities.unshift({
        id: makeId("act"),
        title: `${order.id} 提交${report.processName}报工`,
        meta: `${input.operator} · 刚刚`,
        note: `良品 ${goodQty}，不良 ${badQty}${report.note ? `，${report.note}` : ""}`,
        createdAt: report.createdAt,
      });
      if (badQty > 0 || report.note) {
        state.alerts.unshift({
          id: makeId("al"),
          title: `${order.id} 现场异常`,
          text: `${report.processName} 备注：${report.note || `不良 ${badQty}`}`,
          severity: badQty > 0 ? "high" : "medium",
          status: "open",
          createdAt: report.createdAt,
        });
      }
      await writeState(state);
      return { report, state: serializePublicState(state) };
    },
    async createStockMovement(input) {
      const state = await readState();
      const material = state.materials.find((item) => item.code === input.materialCode && item.batchNo === input.batchNo);
      if (!material) throw new Error("物料批次不存在");
      const qty = Number(input.qty || 0);
      const sign = input.type === "out" ? -1 : 1;
      material.stockQty = Number(material.stockQty || 0) + sign * qty;
      if (input.location) material.location = input.location;
      const movement = {
        id: makeId("stk"),
        materialCode: input.materialCode,
        batchNo: input.batchNo,
        type: input.type || "in",
        qty,
        location: input.location || material.location,
        note: input.note || "",
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
      if (material.stockQty < material.safetyQty) {
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
    async getState() {
      return serializePublicState(await readPostgresState(pool));
    },
    async createReport(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const orderResult = await client.query("select * from work_orders where id=$1 for update", [input.workOrderId]);
        const order = orderResult.rows[0];
        if (!order) throw new Error("工单不存在");
        const goodQty = Number(input.goodQty || 0);
        const badQty = Number(input.badQty || 0);
        const report = {
          id: makeId("rep"),
          workOrderId: input.workOrderId,
          processName: input.processName || order.current_process,
          goodQty,
          badQty,
          note: input.note || "",
          operator: input.operator,
          createdAt: new Date().toISOString(),
        };
        await client.query(
          "insert into reports(id, work_order_id, process_name, good_qty, bad_qty, note, operator, created_at) values($1,$2,$3,$4,$5,$6,$7,$8)",
          [report.id, report.workOrderId, report.processName, report.goodQty, report.badQty, report.note, report.operator, report.createdAt]
        );
        await client.query("update work_orders set done_qty=least(planned_qty, done_qty + $1) where id=$2", [goodQty, report.workOrderId]);
        await client.query("insert into activities(id,title,meta,note,created_at) values($1,$2,$3,$4,$5)", [
          makeId("act"),
          `${order.id} 提交${report.processName}报工`,
          `${input.operator} · 刚刚`,
          `良品 ${goodQty}，不良 ${badQty}${report.note ? `，${report.note}` : ""}`,
          report.createdAt,
        ]);
        if (badQty > 0 || report.note) {
          await client.query("insert into alerts(id,title,text,severity,status,created_at) values($1,$2,$3,$4,$5,$6)", [
            makeId("al"),
            `${order.id} 现场异常`,
            `${report.processName} 备注：${report.note || `不良 ${badQty}`}`,
            badQty > 0 ? "high" : "medium",
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
        const result = await client.query("select * from materials where code=$1 and batch_no=$2 for update", [input.materialCode, input.batchNo]);
        const material = result.rows[0];
        if (!material) throw new Error("物料批次不存在");
        const qty = Number(input.qty || 0);
        const sign = input.type === "out" ? -1 : 1;
        const nextQty = Number(material.stock_qty) + sign * qty;
        const movement = {
          id: makeId("stk"),
          materialCode: input.materialCode,
          batchNo: input.batchNo,
          type: input.type || "in",
          qty,
          location: input.location || material.location,
          note: input.note || "",
          operator: input.operator,
          createdAt: new Date().toISOString(),
        };
        await client.query("update materials set stock_qty=$1, location=$2 where code=$3 and batch_no=$4", [nextQty, movement.location, input.materialCode, input.batchNo]);
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
      good_qty integer not null default 0,
      bad_qty integer not null default 0,
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
    pool.query('select id, work_order_id as "workOrderId", process_name as "processName", good_qty as "goodQty", bad_qty as "badQty", note, operator, created_at as "createdAt" from reports order by created_at desc limit 50'),
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
