begin;
create table public.carry_reentry_links (
 token_hash text primary key, room_id uuid not null references public.rooms(id),
 member_id uuid not null references public.room_members(id), issuer_id uuid not null references public.room_members(id),
 previous_owner uuid not null, expires_at timestamptz not null default now()+interval '30 minutes', used_at timestamptz
);
alter table public.carry_reentry_links enable row level security;
revoke all on public.carry_reentry_links from public,anon,authenticated;

create function public.carry_issue_reentry(p_room_id uuid,p_member_id uuid) returns text
language plpgsql security definer set search_path=public,pg_temp as $$
declare me room_members; target room_members; s jsonb; head_id uuid; token text;
begin
 perform 1 from rooms where id=p_room_id for update;
 select * into me from room_members where room_id=p_room_id and user_id=carry_owner() and left_at is null;
 select * into target from room_members where room_id=p_room_id and id=p_member_id and left_at is null;
 if me.id is null or target.id is null or me.id=target.id then raise exception '다른 현재 팀원의 재입장만 도울 수 있어요.'; end if;
 select state into s from room_snapshots where room_id=p_room_id;
 head_id:=coalesce((s#>>'{room,leaderId}')::uuid,(select id from room_members where room_id=p_room_id and left_at is null and is_creator));
 if head_id is null or (me.id<>head_id and target.id<>head_id) then raise exception '팀장만 팀원 링크를 발급할 수 있어요.'; end if;
 update carry_reentry_links set used_at=now() where member_id=target.id and used_at is null;
 token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into carry_reentry_links(token_hash,room_id,member_id,issuer_id,previous_owner)
 values(encode(sha256(convert_to(token,'UTF8')),'hex'),p_room_id,target.id,me.id,target.user_id);
 return token;
end $$;

create function public.carry_preview_reentry(p_token text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare link carry_reentry_links; target room_members; issuer room_members; s jsonb; head_id uuid;
begin
 if auth.uid() is null or p_token is null or p_token !~ '^[a-f0-9]{64}$' then raise exception '유효하지 않은 재입장 링크예요.'; end if;
 select * into link from carry_reentry_links where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 if link.token_hash is null or link.used_at is not null or link.expires_at<=now() then raise exception '만료되었거나 이미 사용한 링크예요. 팀원에게 새 링크를 요청해주세요.'; end if;
 select * into target from room_members where id=link.member_id and left_at is null;
 select * into issuer from room_members where id=link.issuer_id and left_at is null;
 select state into s from room_snapshots where room_id=link.room_id;
 head_id:=coalesce((s#>>'{room,leaderId}')::uuid,(select id from room_members where room_id=link.room_id and left_at is null and is_creator));
 if target.id is null or issuer.id is null or head_id is null or target.user_id<>link.previous_owner or (issuer.id<>head_id and target.id<>head_id) then raise exception '팀 구성이 변경되었어요. 새 링크를 요청해주세요.'; end if;
 return jsonb_build_object('name',target.name,'roomName',s#>>'{room,name}','expiresAt',link.expires_at);
end $$;

create function public.carry_redeem_reentry(p_token text,p_confirm boolean) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare link carry_reentry_links; target room_members; s jsonb; who uuid:=carry_owner(); events jsonb;
begin
 if p_confirm is distinct from true or who is null then raise exception '본인 여부를 확인해주세요.'; end if;
 select * into link from carry_reentry_links where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 if link.token_hash is null then raise exception '유효하지 않은 재입장 링크예요.'; end if;
 perform 1 from rooms where id=link.room_id for update;
 perform carry_preview_reentry(p_token);
 select * into target from room_members where id=link.member_id for update;
 if exists(select 1 from room_members where room_id=link.room_id and user_id=who and id<>target.id) then raise exception '이 브라우저는 이미 다른 팀원으로 참가 중이에요. 본인의 다른 브라우저에서 열어주세요.'; end if;
 update room_members set user_id=who where id=target.id;
 if target.is_creator then update rooms set creator_user_id=who where id=link.room_id; end if;
 update carry_reentry_links set used_at=now() where member_id=target.id and used_at is null;
 select state into s from room_snapshots where room_id=link.room_id for update;
 select coalesce(jsonb_agg(value),'[]'::jsonb) into events from (select value from jsonb_array_elements(coalesce(s#>'{room,reentries}','[]'::jsonb)) with ordinality order by ordinality limit 9) recent;
 events:=jsonb_build_array(jsonb_build_object('memberId',target.id,'name',target.name,'at',now()))||events;
 update room_snapshots set state=jsonb_set(s,'{room,reentries}',events),updated_at=now() where room_id=link.room_id returning state into s;
 return jsonb_build_object('room_id',link.room_id,'member_id',target.id,'state',s);
end $$;
revoke all on function public.carry_issue_reentry(uuid,uuid),public.carry_preview_reentry(text),public.carry_redeem_reentry(text,boolean) from public,anon,authenticated;
grant execute on function public.carry_issue_reentry(uuid,uuid),public.carry_preview_reentry(text),public.carry_redeem_reentry(text,boolean) to authenticated;
commit;
