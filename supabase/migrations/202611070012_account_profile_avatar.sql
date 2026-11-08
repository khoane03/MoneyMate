-- Keep account profile private. Group rosters receive only the member's chosen
-- display name and private avatar object path through the existing scoped RLS.
alter table public.profiles
  add column avatar_storage_path text,
  add constraint profiles_avatar_path_owner_folder check (
    avatar_storage_path is null or avatar_storage_path ~ ('^'||user_id::text||'/[0-9a-f-]{36}\.jpg$')
  );

alter table public.connection_members add column avatar_storage_path text;
alter table public.connection_members drop constraint if exists connection_members_display_name_check;
alter table public.connection_members add constraint connection_members_display_name_check
  check (char_length(trim(display_name)) between 1 and 100);
update public.connection_members m
set avatar_storage_path=p.avatar_storage_path
from public.profiles p where p.user_id=m.user_id;

create or replace function public.sync_profile_to_group_rosters()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.connection_members
  set display_name=coalesce(nullif(trim(new.display_name),''),'Thành viên'),
      avatar_storage_path=new.avatar_storage_path
  where user_id=new.user_id;
  return new;
end;
$$;
revoke all on function public.sync_profile_to_group_rosters() from public, anon, authenticated;
create trigger profiles_sync_group_rosters
  after update of display_name,avatar_storage_path on public.profiles
  for each row execute function public.sync_profile_to_group_rosters();

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('profile-avatars','profile-avatars',false,3145728,array['image/jpeg'])
on conflict (id) do update set public=false,file_size_limit=3145728,allowed_mime_types=array['image/jpeg'];

create policy "avatar owner uploads own image" on storage.objects for insert to authenticated
  with check (bucket_id='profile-avatars' and (storage.foldername(name))[1]=(select auth.uid())::text and name ~ '^[^/]+/[0-9a-f-]{36}\.jpg$');
create policy "avatar owner or group member reads image" on storage.objects for select to authenticated
  using (bucket_id='profile-avatars' and (
    (storage.foldername(name))[1]=(select auth.uid())::text
    or exists (
      select 1 from public.connection_members viewer
      join public.connections c on c.id=viewer.connection_id and c.status='active'
      join public.connection_members owner on owner.connection_id=viewer.connection_id
      where viewer.user_id=(select auth.uid())
        and owner.user_id::text=(storage.foldername(name))[1]
        and owner.avatar_storage_path=name
    )
  ));
create policy "avatar owner replaces own image" on storage.objects for update to authenticated
  using (bucket_id='profile-avatars' and (storage.foldername(name))[1]=(select auth.uid())::text)
  with check (bucket_id='profile-avatars' and (storage.foldername(name))[1]=(select auth.uid())::text and name ~ '^[^/]+/[0-9a-f-]{36}\.jpg$');
create policy "avatar owner deletes own image" on storage.objects for delete to authenticated
  using (bucket_id='profile-avatars' and (storage.foldername(name))[1]=(select auth.uid())::text);
