-- Clients can read their rooms; only validated RPCs can mutate shared data.
begin;
revoke insert,update,delete,truncate,references,trigger on public.rooms,public.room_members,public.roles,public.role_preferences,public.leader_consents,public.role_acceptances,public.reminders,public.room_snapshots from anon,authenticated;
create or replace function public.save_room_snapshot(p_room_id uuid,p_state jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.rooms; members jsonb;
begin
 select * into r from rooms where id=p_room_id for update;
 if auth.uid() is null or r.creator_user_id is distinct from auth.uid() then raise exception '방 개설자만 초기화할 수 있어요.' using errcode='42501'; end if;
 if exists(select 1 from room_snapshots where room_id=p_room_id) then raise exception '새 버전을 사용하려면 새로고침해주세요.'; end if;
 select jsonb_agg(jsonb_build_object('id',id,'name',name,'isCreator',is_creator,'isHost',is_leader,'contact',jsonb_strip_nulls(jsonb_build_object('phone',phone,'kakao',kakao_id,'email',email))) order by joined_at) into members from room_members where room_id=p_room_id;
 insert into room_snapshots(room_id,state) values(p_room_id,jsonb_build_object('room',jsonb_build_object('id',r.id,'code',r.invite_code,'name',r.name,'size',r.member_limit,'deadline',r.final_deadline,'createdAt',r.created_at,'members',members,'roles','[]'::jsonb),'result',null,'assignments','[]'::jsonb,'screen','lobby','lastAccessedAt',now()));
end $$;
revoke all on function public.save_room_snapshot(uuid,jsonb) from public;
grant execute on function public.save_room_snapshot(uuid,jsonb) to authenticated;
commit;
