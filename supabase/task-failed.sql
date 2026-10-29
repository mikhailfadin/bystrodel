-- Отметка «не выполнено» (✗): закрытая задача с failed = true. done остаётся true, поэтому «Сегодня»/фокус её не видят.
alter table public.tasks add column if not exists failed boolean not null default false;
