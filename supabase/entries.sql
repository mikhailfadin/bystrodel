-- Такт: журнал Фокус бара — общий для «Такта», телефона и VibeBar на маке.
-- Запускать один раз в SQL Editor проекта takt.

create table if not exists public.entries (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  at          text not null,                        -- местное время ГГГГ-ММ-ДДTЧЧ:ММ:СС
  kind        text not null check (kind in ('task', 'idea', 'todo', 'stop')),
  text        text not null default '',
  task_id     text,                                 -- задача «Такта», если дело запущено перетаскиванием
  closed      boolean not null default false,       -- ✕ у «не забыть»
  source      text not null default '',             -- takt | mac
  deleted     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists entries_user_updated on public.entries (user_id, updated_at);

alter table public.entries enable row level security;

create policy "entries: читать свои"   on public.entries for select using (user_id = auth.uid());
create policy "entries: добавлять свои" on public.entries for insert with check (user_id = auth.uid());
create policy "entries: менять свои"    on public.entries for update using (user_id = auth.uid()) with check (user_id = auth.uid());

alter publication supabase_realtime add table public.entries;
