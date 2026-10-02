-- Пояснение у задачи: текст едет вместе с делом между хранилищем и задачником.
alter table public.tasks add column if not exists note text not null default '';
