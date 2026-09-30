-- Дата создания заметки: чтобы «Новые» считались по появлению, а не по правке файла.
-- Запускать один раз в SQL Editor проекта takt.

alter table public.bd_notes add column if not exists created timestamptz;
