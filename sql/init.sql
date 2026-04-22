create table if not exists stores (
  id text primary key,
  name text not null,
  region text not null default ''
);

create table if not exists products (
  id text primary key,
  name text not null,
  category text not null default ''
);

create table if not exists plans (
  period text not null,
  store_id text not null references stores(id),
  product_id text not null references products(id),
  amount numeric(14, 2) not null default 0
);

create index if not exists idx_plans_period on plans(period);
create index if not exists idx_plans_period_store on plans(period, store_id);
create index if not exists idx_plans_period_product on plans(period, product_id);

create table if not exists sales (
  id bigserial primary key,
  period text not null,
  store_id text not null references stores(id),
  product_id text not null references products(id),
  amount numeric(14, 2) not null default 0,
  cost numeric(14, 2) not null default 0,
  quantity numeric(14, 2) not null default 0,
  sold_at timestamptz not null default now()
);

create index if not exists idx_sales_period on sales(period);
create index if not exists idx_sales_period_store on sales(period, store_id);
create index if not exists idx_sales_period_product on sales(period, product_id);
create index if not exists idx_sales_sold_at on sales(sold_at desc);

create table if not exists marketing_metrics (
  id bigserial primary key,
  period text not null,
  channel_id text not null,
  channel_name text not null,
  spend numeric(14, 2) not null default 0,
  leads numeric(14, 2) not null default 0,
  orders numeric(14, 2) not null default 0,
  revenue numeric(14, 2) not null default 0,
  impressions numeric(14, 2) not null default 0,
  clicks numeric(14, 2) not null default 0,
  sessions numeric(14, 2) not null default 0
);

create index if not exists idx_marketing_period on marketing_metrics(period);
create index if not exists idx_marketing_period_channel on marketing_metrics(period, channel_id);
