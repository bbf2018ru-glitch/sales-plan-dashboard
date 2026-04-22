-- Миграция для существующих баз: добавляет колонку себестоимости в sales
alter table sales add column if not exists cost numeric(14, 2) not null default 0;
