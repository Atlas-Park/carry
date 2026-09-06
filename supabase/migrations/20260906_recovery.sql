-- Stable owner identity, recoverable membership and append-only room revisions.
begin;
alter table public.rooms add column if not exists archived_at timestamptz;
alter table public.room_members add column if not exists left_at timestamptz;
alter table public.room_members add column if not exists removed_by uuid;
create table if not exists public.carry_identity_links(user_id uuid primary key references auth.users(id),owner_id uuid not null references auth.users(id));
create table if not exists public.carry_recovery_keys(owner_id uuid primary key references auth.users(id),key_hash text unique not null,created_at timestamptz not null default now());
create table if not exists public.carry_room_history(id bigint generated always as identity primary key,room_id uuid not null,state jsonb not null,saved_at timestamptz not null default now());
create index if not exists carry_room_history_room on public.carry_room_history(room_id,saved_at desc);
alter table public.carry_identity_links enable row level security;
alter table public.carry_recovery_keys enable row level security;
alter table public.carry_room_history enable row level security;
revoke all on public.carry_identity_links,public.carry_recovery_keys,public.carry_room_history from public,anon,authenticated;

create or replace function public.carry_owner() returns uuid language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce((select owner_id from carry_identity_links where user_id=auth.uid()),auth.uid());
$$;
create or replace function public.is_room_member(target_room_id uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from room_members where room_id=target_room_id and user_id=public.carry_owner() and left_at is null);
$$;
create or replace function public.is_room_creator(target_room_id uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from room_members where room_id=target_room_id and user_id=public.carry_owner() and left_at is null and is_creator);
$$;
create or replace function public.is_room_leader(target_room_id uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from room_members where room_id=target_room_id and user_id=public.carry_owner() and left_at is null and is_leader);
$$;

create or replace function public.carry_issue_recovery_key() returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare k text; who uuid:=public.carry_owner();
begin
 if who is null then raise exception '연결을 먼저 확인해주세요.'; end if;
 k:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into carry_recovery_keys(owner_id,key_hash) values(who,encode(sha256(convert_to(k,'UTF8')),'hex')) on conflict(owner_id) do update set key_hash=excluded.key_hash,created_at=now();
 return k;
end $$;
create or replace function public.carry_recover(p_key text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare target uuid; current_owner uuid:=public.carry_owner();
begin
 if auth.uid() is null or p_key !~ '^[a-f0-9]{64}$' then raise exception '복구 키를 확인해주세요.'; end if;
 select owner_id into target from carry_recovery_keys where key_hash=encode(sha256(convert_to(p_key,'UTF8')),'hex');
 if target is null then raise exception '복구 키를 확인해주세요.'; end if;
 if current_owner=target then return; end if;
 if exists(select 1 from room_members where user_id=current_owner) then raise exception '현재 기기의 방을 보존하기 위해 다른 사용자로 전환할 수 없어요. 새 브라우저에서 복구해주세요.'; end if;
 insert into carry_identity_links(user_id,owner_id) values(auth.uid(),target) on conflict(user_id) do update set owner_id=excluded.owner_id;
end $$;

-- Keep every saved revision, including the state before membership changes.
create or replace function public.carry_record_revision() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if TG_OP='UPDATE' and new.state is not distinct from old.state then return new; end if;
 new.state:=jsonb_set(new.state,'{revision}',to_jsonb(case when TG_OP='INSERT' then 1 else coalesce((old.state->>'revision')::bigint,0)+1 end));
 insert into carry_room_history(room_id,state) values(new.room_id,new.state);
 return new;
end $$;
insert into carry_room_history(room_id,state) select room_id,state from room_snapshots s where not exists(select 1 from carry_room_history h where h.room_id=s.room_id);
drop trigger if exists carry_revision on public.room_snapshots;
create trigger carry_revision before insert or update on public.room_snapshots for each row execute function public.carry_record_revision();

-- Initialize a snapshot in the same transaction as creator membership.
create or replace function public.carry_init_room() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rooms;
begin
 if not new.is_creator then return new; end if;
 select * into r from rooms where id=new.room_id;
 insert into room_snapshots(room_id,state) values(r.id,jsonb_build_object('room',jsonb_build_object('id',r.id,'code',r.invite_code,'name',r.name,'size',r.member_limit,'deadline',r.final_deadline,'createdAt',r.created_at,'roles','[]'::jsonb,'members',jsonb_build_array(jsonb_build_object('id',new.id,'name',new.name,'isCreator',true,'isHost',false,'contact',jsonb_strip_nulls(jsonb_build_object('phone',new.phone,'kakao',new.kakao_id,'email',new.email))))),'assignments','[]'::jsonb,'result',null,'screen','lobby','lastAccessedAt',now())) on conflict(room_id) do nothing;
 return new;
end $$;
drop trigger if exists carry_init_room on public.room_members;
create trigger carry_init_room after insert on public.room_members for each row execute function public.carry_init_room();

-- Legacy clients can acknowledge initialization, but never overwrite a room.
create or replace function public.save_room_snapshot(p_room_id uuid,p_state jsonb) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_room_creator(p_room_id) then raise exception '방 개설자만 초기화할 수 있어요.'; end if;
 if exists(select 1 from room_snapshots where room_id=p_room_id and state#>>'{room,leaderId}' is null and jsonb_array_length(state#>'{room,members}')=1) then return; end if;
 raise exception '새 버전을 사용하려면 새로고침해주세요.';
end $$;

create or replace function public.carry_restore_room(p_room_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.room_members; r public.rooms; s jsonb; n int; member_json jsonb;
begin
 select * into r from rooms where id=p_room_id for update;
 select * into m from room_members where room_id=p_room_id and user_id=public.carry_owner();
 if m.id is null or m.removed_by is not null then raise exception '이 방에 다시 참여할 수 없어요.'; end if;
 select state into s from room_snapshots where room_id=p_room_id for update;
 if m.left_at is null then return jsonb_build_object('room_id',p_room_id,'member_id',m.id,'state',s); end if;
 n:=jsonb_array_length(s#>'{room,members}');
 if n>=r.member_limit or s#>>'{room,leaderId}' is not null then raise exception '이미 참가가 마감된 방이에요.'; end if;
 if exists(select 1 from room_members where room_id=p_room_id and left_at is null and lower(name)=lower(m.name)) then raise exception '같은 이름의 팀원이 있어요. 관리자에게 문의해주세요.'; end if;
 update room_members set left_at=null,is_creator=(n=0),is_leader=false where id=m.id;
 if n=0 then update rooms set creator_user_id=m.user_id where id=p_room_id; end if;
 update rooms set archived_at=null where id=p_room_id;
 member_json:=jsonb_build_object('id',m.id,'name',m.name,'isCreator',n=0,'isHost',false,'contact',jsonb_strip_nulls(jsonb_build_object('phone',m.phone,'kakao',m.kakao_id,'email',m.email)));
 update room_snapshots set state=jsonb_set(s,'{room,members}',(s#>'{room,members}')||jsonb_build_array(member_json)),updated_at=now() where room_id=p_room_id returning state into s;
 return jsonb_build_object('room_id',p_room_id,'member_id',m.id,'state',s);
end $$;

create or replace function public.carry_my_rooms() returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if public.carry_owner() is null then raise exception '연결을 먼저 확인해주세요.'; end if;
 if exists(select 1 from room_members m left join room_snapshots s on s.room_id=m.room_id where m.user_id=public.carry_owner() and s.room_id is null) then raise exception '방 기록을 불러오지 못했어요. 방을 새로 만들지 말고 관리자에게 복구를 요청해주세요.'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('roomId',m.room_id,'memberId',m.id,'record',case when m.left_at is null then s.state else jsonb_build_object('room',jsonb_build_object('name',s.state#>>'{room,name}')) end,'left',m.left_at is not null,'canRestore',m.removed_by is null,'updatedAt',s.updated_at) order by s.updated_at desc) from room_members m join room_snapshots s on s.room_id=m.room_id where m.user_id=public.carry_owner() and m.removed_by is null),'[]'::jsonb);
end $$;

-- Apply narrow changes to the already-deployed workflow function.
do $migration$
declare f text;
begin
 f:=pg_get_functiondef('public.create_room(text,timestamptz,smallint,text,text,text,text)'::regprocedure);
 execute replace(f,'auth.uid()','public.carry_owner()');
 f:=pg_get_functiondef('public.carry_command(uuid,text,jsonb)'::regprocedure);
 if position('delete from rooms where id=p_room_id' in f)=0 then raise exception 'Unexpected workflow definition; migration stopped'; end if;
 f:=replace(f,'user_id=auth.uid()','user_id=public.carry_owner() and left_at is null');
 f:=replace(f,'delete from room_members where room_id=p_room_id and id=target;','update room_members set left_at=now(),removed_by=case when p_action=''kick'' then me else null end where room_id=p_room_id and id=target;');
 f:=replace(f,'if jsonb_array_length(items)=0 then delete from rooms where id=p_room_id;return null; end if;','if jsonb_array_length(items)=0 then update rooms set archived_at=now() where id=p_room_id; update room_snapshots set state=jsonb_set(s#-''{room,decision}'',''{room,members}'',items),updated_at=now() where room_id=p_room_id; return null; end if;');
 f:=replace(f,'select id::text into candidate from room_members where room_id=p_room_id order by random()','select id::text into candidate from room_members where room_id=p_room_id and left_at is null order by random()');
 f:=replace(f,'where room_id=p_room_id and id::text=p_payload->>''value''','where room_id=p_room_id and left_at is null and id::text=p_payload->>''value''');
 f:=replace(f,'update room_snapshots set state=s,updated_at=now() where room_id=p_room_id;','update room_snapshots set state=s,updated_at=now() where room_id=p_room_id returning state into s;');
 execute f;
end $migration$;

create or replace function public.join_room(p_invite_code text,p_member_name text,p_phone text default null,p_kakao_id text default null,p_email text default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rooms; m public.room_members; s jsonb; who uuid:=public.carry_owner();
begin
 if who is null then raise exception '연결을 먼저 확인해주세요.'; end if;
 select * into r from rooms where invite_code=upper(trim(p_invite_code)) for update;
 if not found then raise exception '유효하지 않은 초대 코드예요.'; end if;
 select * into m from room_members where room_id=r.id and user_id=who;
 if found then return public.carry_restore_room(r.id); end if;
 select state into s from room_snapshots where room_id=r.id for update;
 if s is null then raise exception '방 데이터 복구가 필요해요. 관리자에게 문의해주세요.'; end if;
 if r.archived_at is not null or s#>>'{room,leaderId}' is not null or s#>>'{room,completedAt}' is not null then raise exception '이미 참가가 마감된 방이에요.'; end if;
 if jsonb_array_length(s#>'{room,members}')>=r.member_limit then raise exception '이미 모든 팀원이 참가한 방이에요.'; end if;
 if coalesce(length(trim(p_member_name)),0) not between 1 and 30 then raise exception '이름을 확인해주세요.'; end if;
 if coalesce(nullif(trim(p_phone),''),nullif(trim(p_kakao_id),''),nullif(trim(p_email),'')) is null then raise exception '연락수단을 하나 이상 입력해주세요.'; end if;
 if exists(select 1 from room_members where room_id=r.id and left_at is null and lower(name)=lower(trim(p_member_name))) then raise exception '이미 사용 중인 이름이에요.'; end if;
 insert into room_members(room_id,user_id,name,phone,kakao_id,email) values(r.id,who,trim(p_member_name),nullif(trim(p_phone),''),nullif(trim(p_kakao_id),''),nullif(trim(p_email),'')) returning * into m;
 update room_snapshots set state=jsonb_set(s,'{room,members}',(s#>'{room,members}')||jsonb_build_array(jsonb_build_object('id',m.id,'name',m.name,'contact',jsonb_strip_nulls(jsonb_build_object('phone',m.phone,'kakao',m.kakao_id,'email',m.email))))),updated_at=now() where room_id=r.id returning state into s;
 return jsonb_build_object('room_id',r.id,'member_id',m.id,'state',s);
end $$;

revoke all on function public.carry_owner(),public.carry_issue_recovery_key(),public.carry_recover(text),public.carry_restore_room(uuid),public.carry_my_rooms(),public.carry_record_revision(),public.carry_init_room() from public,anon,authenticated;
grant execute on function public.carry_owner(),public.carry_issue_recovery_key(),public.carry_recover(text),public.carry_restore_room(uuid),public.carry_my_rooms() to authenticated;
commit;
