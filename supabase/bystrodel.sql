-- Быстродел: копия заметок Obsidian и очередь правок из Mini App.
-- Запускать один раз в SQL Editor проекта takt.

-- 1. Заметки: то, что мост выгружает из Obsidian
create table if not exists public.bd_notes (
  id          text primary key,                    -- хэш пути заметки
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  path        text not null,                       -- путь в волте
  title       text not null default '',
  folder      text not null default '',
  kind        text not null default 'задача',      -- задача/идея/гипотеза/цель/не забыть/материал/контент/разобрать
  status      text not null default 'новое',       -- новое/актуальное/в работе/сделано/когда-нибудь
  quick       boolean not null default false,      -- быстрое дело
  minutes     integer not null default 5,          -- оценка Михаила: 5 или 15
  decided     text not null default 'агент',       -- слово/агент/Михаил
  source      text not null default 'текст',       -- голос/пересылка/текст
  steps       jsonb not null default '[]'::jsonb,  -- [{t:"шаг", done:false, basket:false}]
  starts      integer not null default 0,          -- сделано подходов
  basket      boolean not null default false,      -- взято в корзину на сегодня
  basket_day  date,                                -- день корзины: ночью сбрасывается
  excerpt     text not null default '',            -- первые ~300 знаков
  note_mtime  timestamptz,                         -- когда заметка менялась в Obsidian
  deleted     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create index if not exists bd_notes_user on public.bd_notes (user_id, updated_at);
create index if not exists bd_notes_quick on public.bd_notes (user_id, quick, status);

-- 2. Правки из приложения: мост их применяет к заметкам и помечает applied_at
create table if not exists public.bd_changes (
  id          bigserial primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  note_id     text not null,
  op          text not null,                       -- status/quick/minutes/basket/step/start
  value       jsonb not null default '{}'::jsonb,  -- {"status":"сделано"} / {"index":3,"done":true}
  created_at  timestamptz not null default now(),
  applied_at  timestamptz,
  error       text
);

create index if not exists bd_changes_pending on public.bd_changes (user_id, applied_at, created_at);

-- 3. Критерии: лимит, ключевые слова, признаки — одна строка на пользователя
create table if not exists public.bd_settings (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  limit_min   integer not null default 15,
  keys        jsonb not null default '["быстрое дело","не забыть"]'::jsonb,
  signs       jsonb not null default '["проверить","оплатить","записаться","ответить","позвонить"]'::jsonb,
  suggest_steps boolean not null default true,
  suggest_wiki  boolean not null default true,
  streak      integer not null default 0,
  streak_day  date,
  frozen_week integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- Доступ: каждый видит и меняет только своё
alter table public.bd_notes    enable row level security;
alter table public.bd_changes  enable row level security;
alter table public.bd_settings enable row level security;

do $$
declare t text;
begin
  foreach t in array array['bd_notes','bd_changes','bd_settings'] loop
    execute format('drop policy if exists "%1$s: читать своё" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: добавлять своё" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: менять своё" on public.%1$I', t);
    execute format('create policy "%1$s: читать своё" on public.%1$I for select using (user_id = auth.uid())', t);
    execute format('create policy "%1$s: добавлять своё" on public.%1$I for insert with check (user_id = auth.uid())', t);
    execute format('create policy "%1$s: менять своё" on public.%1$I for update using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;
