insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('setup-screenshots','setup-screenshots',false,4194304,array['image/png','image/jpeg','image/webp']);
-- Authenticated users may read only registered evidence belonging to them.
-- Uploads go through byte validation on the trusted application server. No browser writes/deletes.
create policy setup_screenshot_owner_read on storage.objects for select to authenticated
using(bucket_id='setup-screenshots' and exists(
 select 1 from public.setup_screenshots s where s.storage_path=name and s.user_id=auth.uid()
));
-- Restrictive policies also prevent an unrelated permissive policy from opening this bucket.
create policy setup_screenshot_read_guard on storage.objects as restrictive for select to anon,authenticated
using(bucket_id<>'setup-screenshots' or exists(select 1 from public.setup_screenshots s where s.storage_path=name and s.user_id=auth.uid()));
create policy setup_screenshot_insert_guard on storage.objects as restrictive for insert to anon,authenticated
with check(bucket_id<>'setup-screenshots');
create policy setup_screenshot_update_guard on storage.objects as restrictive for update to anon,authenticated
using(bucket_id<>'setup-screenshots') with check(bucket_id<>'setup-screenshots');
create policy setup_screenshot_delete_guard on storage.objects as restrictive for delete to anon,authenticated
using(bucket_id<>'setup-screenshots');
