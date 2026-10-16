-- Быстродел: картинки из заметок Obsidian.
-- Мост (bystrodel-cloud.py) кладёт ужатые копии в закрытый бакет vault по пути <user_id>/<имя файла>,
-- приложение читает их по подписанным ссылкам. Вставить в SQL Editor панели Supabase и выполнить.
-- Повторный запуск безопасен.

-- 1. Закрытый бакет: до 10 МБ на файл, только картинки.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vault', 'vault', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- 2. Доступ: владелец (authenticated) работает только с объектами, у которых
--    первая часть пути равна его auth.uid(). Гостю (anon) доступа нет.
--    Для заливки с upsert нужны все три права: добавлять, обновлять, читать.

drop policy if exists "vault_select_own" on storage.objects;
create policy "vault_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'vault' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "vault_insert_own" on storage.objects;
create policy "vault_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vault' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "vault_update_own" on storage.objects;
create policy "vault_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'vault' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'vault' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "vault_delete_own" on storage.objects;
create policy "vault_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'vault' and (storage.foldername(name))[1] = auth.uid()::text);
