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
