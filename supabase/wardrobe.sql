-- The Wardrobe: a private bucket for piece thumbnails. Run after schema.sql (and larder.sql). Safe to run again.
-- Each photo lives at wardrobe/<user id>/<piece id>.jpg and only that user can read, add, replace or remove it.
-- Thumbnails are about 480 px and 30-60 KB; 200 pieces come to roughly 10 MB.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wardrobe', 'wardrobe', false, 1048576, array['image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "wardrobe owner reads" on storage.objects;
create policy "wardrobe owner reads" on storage.objects
  for select to authenticated
  using (bucket_id = 'wardrobe' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "wardrobe owner adds" on storage.objects;
create policy "wardrobe owner adds" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'wardrobe' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "wardrobe owner replaces" on storage.objects;
create policy "wardrobe owner replaces" on storage.objects
  for update to authenticated
  using (bucket_id = 'wardrobe' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'wardrobe' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "wardrobe owner removes" on storage.objects;
create policy "wardrobe owner removes" on storage.objects
  for delete to authenticated
  using (bucket_id = 'wardrobe' and (storage.foldername(name))[1] = (select auth.uid())::text);
