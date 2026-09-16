-- Такт: приём записей с Apple Watch (команда «Такт» в приложении «Команды»).
-- Команда шлёт личный ключ + действие; функция находит владельца ключа и пишет запись в entries.
-- В базе хранится только хэш ключа. Время — московское, как часы на устройствах.

create schema if not exists private;
revoke all on schema private from anon, authenticated;

create table if not exists private.watch_keys (
  key_hash   text primary key,                    -- sha256 ключа, hex
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.takt_watch(key text, action text, phrase text default '')
returns text
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uid   uuid;
  nowl  timestamp := now() at time zone 'Europe/Moscow';
  at_s  text := to_char(now() at time zone 'Europe/Moscow', 'YYYY-MM-DD"T"HH24:MI:SS');
  today text := to_char(now() at time zone 'Europe/Moscow', 'YYYY-MM-DD');
  t     text;
  low   text;
  first text;
  rest  text;
  kind  text;
  body  text;
  rtext text;
  rtask text;
begin
  select w.user_id into uid from private.watch_keys w
   where w.key_hash = encode(sha256(convert_to(coalesce(key, ''), 'UTF8')), 'hex');
  if uid is null then
    return 'Ключ не подошёл';
  end if;

  if action = 'pause' then
    kind := 'stop'; body := 'пауза';
  elsif action = 'end' then
    kind := 'stop'; body := 'стоп';
  elsif action = 'resume' then
    select e.text, e.task_id into rtext, rtask
      from public.entries e
      left join public.tasks k on k.id = e.task_id and k.user_id = uid
     where e.user_id = uid and not e.deleted and e.kind = 'task'
       and e.at like today || '%' and coalesce(k.done, false) = false
     order by e.at desc limit 1;
    if rtext is null then
      return 'Сегодня нечего продолжать';
    end if;
    kind := 'task'; body := rtext;
  elsif action = 'say' then
    t := regexp_replace(trim(coalesce(phrase, '')), '\s+', ' ', 'g');
    t := trim(regexp_replace(t, '^["''«»]+|["''«»]+$', '', 'g'));
    t := trim(regexp_replace(t, '[.!]+$', ''));
    if t = '' then
      return 'Ничего не услышал';
    end if;
    low := lower(t);
    first := split_part(regexp_replace(low, '[,.;:!?]', ' ', 'g'), ' ', 1);
    rest := trim(regexp_replace(substr(t, length(split_part(t, ' ', 1)) + 1), '^[\s,.:;—-]+', ''));
    if low ~ '^не (забыть|забудь)' then
      kind := 'todo';
      body := trim(regexp_replace(coalesce(substring(t from '^\S+\s+\S+(.*)$'), ''), '^[\s,.:;—-]+', ''));
      if body = '' then body := t; end if;
    elsif first in ('незабыть', 'напомнить', 'напоминание', 'важно', 'запомнить', 'todo') then
      kind := 'todo'; body := coalesce(nullif(rest, ''), t);
    elsif first in ('идея', 'идеи', 'идею', 'мысль', 'мысли', 'заметка', 'заметку') then
      kind := 'idea'; body := coalesce(nullif(rest, ''), t);
    elsif first in ('перерыв', 'пауза', 'стоп', 'конец', 'финиш', 'обед') then
      kind := 'stop'; body := t;
    else
      kind := 'task'; body := t;
    end if;
  else
    return 'Неизвестное действие';
  end if;

  insert into public.entries (id, user_id, at, kind, text, task_id, closed, source, deleted, updated_at)
  values ('w' || substr(md5(random()::text || clock_timestamp()::text), 1, 15), uid, at_s, kind, body,
          case when action = 'resume' then rtask else null end, false, 'watch', false, now());

  return case
    when kind = 'idea' then '💡 Идея записана'
    when kind = 'todo' then '❗ Записано в «Не забыть»'
    when kind = 'stop' and lower(body) ~ '^(стоп|конец|финиш)' then '■ День закрыт'
    when kind = 'stop' then '⏸ Пауза'
    else '▶ ' || body
  end;
end;
$$;

revoke all on function public.takt_watch(text, text, text) from public;
grant execute on function public.takt_watch(text, text, text) to anon, authenticated;

-- ответ для «Команд» в виде {"msg": "..."} — простой текст PostgREST не отдаёт
create or replace function public.takt_watch_json(key text, action text, phrase text default '')
returns json
language sql
as $$ select json_build_object('msg', public.takt_watch(key, action, phrase)) $$;
revoke all on function public.takt_watch_json(text, text, text) from public;
grant execute on function public.takt_watch_json(text, text, text) to anon, authenticated;

-- ключ Михаила: хэш вставляется отдельно, сам ключ в базе не хранится
-- insert into private.watch_keys (key_hash, user_id)
-- select '<sha256>', id from auth.users where email = '<почта>';
