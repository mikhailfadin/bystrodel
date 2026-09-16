-- Такт: задачи одного пользователя, синхронизация телефон ↔ компьютер.
-- Запускать один раз в SQL Editor проекта takt.

create table if not exists public.tasks (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title       text not null default '',
  date        text not null,                       -- ГГГГ-ММ-ДД, 'inbox' или 'someday'
  time        text not null default '',            -- ЧЧ:ММ или пусто
  prio        boolean not null default false,
  done        boolean not null default false,
  done_at     timestamptz,
  pos         integer not null default 0,
  carry       integer not null default 0,
  deleted     boolean not null default false,      -- мягкое удаление, чтобы удалённое не воскресало с другого устройства
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()   -- время последней правки на устройстве; побеждает более позднее
);

create index if not exists tasks_user_updated on public.tasks (user_id, updated_at);

alter table public.tasks enable row level security;

create policy "tasks: читать свои"   on public.tasks for select using (user_id = auth.uid());
create policy "tasks: добавлять свои" on public.tasks for insert with check (user_id = auth.uid());
create policy "tasks: менять свои"    on public.tasks for update using (user_id = auth.uid()) with check (user_id = auth.uid());

alter publication supabase_realtime add table public.tasks;
