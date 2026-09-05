-- Carry MVP: atomic room creation/joining and a realtime room snapshot.
-- The normalized tables remain the source for membership and access control.

create table if not exists public.room_snapshots (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.room_snapshots enable row level security;

drop policy if exists "room members can read snapshots" on public.room_snapshots;
create policy "room members can read snapshots"
on public.room_snapshots for select
to authenticated
using (public.is_room_member(room_id));

revoke all on public.room_snapshots from anon, authenticated;
grant select on public.room_snapshots to authenticated;

create or replace function public.create_room(
  p_name text,
  p_final_deadline timestamptz,
  p_member_limit smallint,
  p_member_name text,
  p_phone text default null,
  p_kakao_id text default null,
  p_email text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.rooms;
  v_member public.room_members;
  v_code text;
  v_chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_attempt integer;
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.' using errcode = '42501'; end if;
  if nullif(trim(p_name), '') is null then raise exception '팀플 이름을 입력해주세요.'; end if;
  if nullif(trim(p_member_name), '') is null then raise exception '이름을 입력해주세요.'; end if;
  if p_final_deadline <= now() then raise exception '최종 제출일은 현재보다 이후여야 합니다.'; end if;
  if p_member_limit < 2 or p_member_limit > 8 then raise exception '팀원 수는 2명에서 8명까지 가능합니다.'; end if;
  if coalesce(nullif(trim(p_phone), ''), nullif(trim(p_kakao_id), ''), nullif(trim(p_email), '')) is null then
    raise exception '연락수단을 하나 이상 입력해주세요.';
  end if;

  for v_attempt in 1..100 loop
    select string_agg(substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1), '')
      into v_code from generate_series(1, 6);
    exit when not exists (select 1 from public.rooms where invite_code = v_code);
  end loop;
  if v_code is null or exists (select 1 from public.rooms where invite_code = v_code) then
    raise exception '초대 코드를 만들지 못했습니다. 다시 시도해주세요.';
  end if;

  insert into public.rooms (invite_code, name, creator_user_id, member_limit, final_deadline)
  values (v_code, trim(p_name), v_user_id, p_member_limit, p_final_deadline)
  returning * into v_room;

  insert into public.room_members (room_id, user_id, name, phone, kakao_id, email, is_creator)
  values (
    v_room.id, v_user_id, trim(p_member_name), nullif(trim(p_phone), ''),
    nullif(trim(p_kakao_id), ''), nullif(trim(p_email), ''), true
  ) returning * into v_member;

  return jsonb_build_object(
    'room_id', v_room.id,
    'member_id', v_member.id,
    'invite_code', v_room.invite_code,
    'created_at', v_room.created_at
  );
end;
$$;

create or replace function public.join_room(
  p_invite_code text,
  p_member_name text,
  p_phone text default null,
  p_kakao_id text default null,
  p_email text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.rooms;
  v_member public.room_members;
  v_snapshot public.room_snapshots;
  v_member_json jsonb;
begin
  if v_user_id is null then raise exception '로그인이 필요합니다.' using errcode = '42501'; end if;
  if nullif(trim(p_member_name), '') is null then raise exception '이름을 입력해주세요.'; end if;
  if coalesce(nullif(trim(p_phone), ''), nullif(trim(p_kakao_id), ''), nullif(trim(p_email), '')) is null then
    raise exception '연락수단을 하나 이상 입력해주세요.';
  end if;

  select * into v_room from public.rooms
  where invite_code = upper(trim(p_invite_code))
  for update;
  if not found then raise exception '유효하지 않은 초대 코드예요.'; end if;

  select * into v_member from public.room_members
  where room_id = v_room.id and user_id = v_user_id;
  if found then
    select * into v_snapshot from public.room_snapshots where room_id = v_room.id;
    return jsonb_build_object('room_id', v_room.id, 'member_id', v_member.id, 'state', v_snapshot.state);
  end if;

  if v_room.status <> 'waiting_members' then raise exception '이미 참가가 마감된 방이에요.'; end if;
  if (select count(*) from public.room_members where room_id = v_room.id) >= v_room.member_limit then
    raise exception '이미 모든 팀원이 참가한 방이에요.';
  end if;
  if exists (select 1 from public.room_members where room_id = v_room.id and lower(name) = lower(trim(p_member_name))) then
    raise exception '이미 사용 중인 이름이에요.';
  end if;

  insert into public.room_members (room_id, user_id, name, phone, kakao_id, email)
  values (
    v_room.id, v_user_id, trim(p_member_name), nullif(trim(p_phone), ''),
    nullif(trim(p_kakao_id), ''), nullif(trim(p_email), '')
  ) returning * into v_member;

  select * into v_snapshot from public.room_snapshots where room_id = v_room.id for update;
  v_member_json := jsonb_build_object(
    'id', v_member.id::text,
    'name', v_member.name,
    'contact', jsonb_strip_nulls(jsonb_build_object('phone', v_member.phone, 'kakao', v_member.kakao_id, 'email', v_member.email))
  );
  if found then
    update public.room_snapshots
    set state = jsonb_set(state, '{room,members}', coalesce(state #> '{room,members}', '[]'::jsonb) || v_member_json),
        updated_at = now()
    where room_id = v_room.id
    returning * into v_snapshot;
  end if;

  return jsonb_build_object('room_id', v_room.id, 'member_id', v_member.id, 'state', v_snapshot.state);
end;
$$;

create or replace function public.save_room_snapshot(p_room_id uuid, p_state jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_room_member(p_room_id) then
    raise exception '이 방을 수정할 권한이 없습니다.' using errcode = '42501';
  end if;
  if p_state #>> '{room,id}' is distinct from p_room_id::text then
    raise exception '잘못된 방 데이터입니다.';
  end if;
  insert into public.room_snapshots (room_id, state, updated_at)
  values (p_room_id, p_state, now())
  on conflict (room_id) do update set state = excluded.state, updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.create_room(text,timestamptz,smallint,text,text,text,text) from public;
revoke all on function public.join_room(text,text,text,text,text) from public;
revoke all on function public.save_room_snapshot(uuid,jsonb) from public;
grant execute on function public.create_room(text,timestamptz,smallint,text,text,text,text) to authenticated;
grant execute on function public.join_room(text,text,text,text,text) to authenticated;
grant execute on function public.save_room_snapshot(uuid,jsonb) to authenticated;

alter table public.room_snapshots replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_snapshots'
  ) then
    alter publication supabase_realtime add table public.room_snapshots;
  end if;
end $$;
