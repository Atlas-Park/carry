-- All workflow writes are atomic, membership-scoped commands.
begin;
create or replace function public.carry_command(p_room_id uuid,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare s jsonb; me uuid; creator boolean; leader boolean; d jsonb; votes jsonb; candidate text;
 v jsonb; items jsonb; chosen jsonb; rid text; idx int; n int; deadline timestamptz; prior timestamptz;
 bestworst int; bestsum int; combos int; target uuid;
begin
 perform 1 from rooms where id=p_room_id for update;
 select id,is_creator into me,creator from room_members where room_id=p_room_id and user_id=auth.uid();
 if me is null then raise exception '이 방의 참가자가 아닙니다.' using errcode='42501'; end if;
 select state into s from room_snapshots where room_id=p_room_id for update;
 if s is null then raise exception '방을 다시 열어주세요.'; end if;
 leader:=coalesce(s#>>'{room,leaderId}'=me::text,false);
 n:=jsonb_array_length(s#>'{room,members}'); d:=coalesce(s#>'{room,decision}','{}');
 if s#>>'{room,completedAt}' is not null then raise exception '이미 완료된 프로젝트입니다.'; end if;
 if p_action in ('mode','nominate','reset_decision','consent','reject') then
   if s#>>'{room,leaderId}' is not null then raise exception '이미 팀장이 확정됐어요.'; end if;
   if n<>(s#>>'{room,size}')::int then raise exception '모든 팀원이 모여야 해요.'; end if;
   if p_action in ('mode','nominate','reset_decision') and not creator then raise exception '방 개설자만 선택할 수 있어요.'; end if;
   case p_action
   when 'mode' then
     if coalesce(p_payload->>'value','') not in ('known','random') then raise exception '잘못된 방식입니다.'; end if;
     d:=jsonb_build_object('mode',p_payload->>'value','consents','[]'::jsonb,'version',gen_random_uuid());
   when 'nominate' then
     if d->>'mode' is distinct from 'known' or not exists(select 1 from room_members where room_id=p_room_id and id::text=p_payload->>'value') then raise exception '후보를 다시 선택해주세요.'; end if;
     d:=jsonb_build_object('mode','known','candidate',p_payload->>'value','consents','[]'::jsonb,'version',gen_random_uuid());
   when 'reset_decision' then d:='{}';
   when 'reject' then
     if p_payload->>'version' is distinct from d->>'version' then raise exception '후보가 변경됐어요. 다시 확인해주세요.'; end if;
     d:='{}';
   when 'consent' then
     if p_payload->>'version' is distinct from d->>'version' or d->>'mode' is null or (d->>'mode'='known' and d->>'candidate' is null) then raise exception '후보가 변경됐어요. 다시 확인해주세요.'; end if;
     votes:=coalesce(d->'consents','[]');
     if not votes @> jsonb_build_array(me::text) then votes:=votes||jsonb_build_array(me::text); end if;
     d:=jsonb_set(d,'{consents}',votes);
     if jsonb_array_length(votes)=n then
       if d->>'mode'='known' then candidate:=d->>'candidate'; else select id::text into candidate from room_members where room_id=p_room_id order by random() limit 1; end if;
       s:=jsonb_set(s,'{room,leaderId}',to_jsonb(candidate));
       s:=jsonb_set(s,'{room,members}',(select jsonb_agg(m||jsonb_build_object('isHost',m->>'id'=candidate)) from jsonb_array_elements(s#>'{room,members}') m));
       update room_members set is_leader=(id::text=candidate) where room_id=p_room_id;
     end if;
   end case;
   s:=jsonb_set(s,'{room,decision}',d);
 elsif p_action='roles' then
   if not leader or jsonb_array_length(s->'assignments')>0 then raise exception '팀장만 배정 전에 역할을 변경할 수 있어요.'; end if;
   items:=p_payload->'roles';
   if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items)<>n then raise exception '팀원 수만큼 역할을 설정해주세요.'; end if;
   if (select count(distinct x->>'id') from jsonb_array_elements(items)x)<>n or (select count(distinct trim(x->>'name')) from jsonb_array_elements(items)x)<>n then raise exception '역할이 중복됐어요.'; end if;
   prior:=now();
   for v in select * from jsonb_array_elements(items) loop
     deadline:=(v->>'deadline')::timestamptz;
     if coalesce(length(trim(v->>'name')),0) not between 1 and 30 or coalesce(length(trim(v->>'deliverable')),0) not between 1 and 120 or deadline is null or deadline<=prior or deadline>=(s#>>'{room,deadline}')::timestamptz then raise exception '역할 이름·결과물·마감 순서를 확인해주세요.'; end if;
     prior:=deadline;
   end loop;
   if items is distinct from s#>'{room,roles}' then
     s:=jsonb_set(s,'{room,roles}',items);
     s:=jsonb_set(s,'{room,members}',(select jsonb_agg((m-'preferences')||'{"submitted":false}'::jsonb) from jsonb_array_elements(s#>'{room,members}')m));
   end if;
 elsif p_action='preferences' then
   if jsonb_array_length(s->'assignments')>0 then raise exception '이미 역할이 배정됐어요.'; end if;
   items:=p_payload->'preferences';
   if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items)<>n or (select count(distinct x) from jsonb_array_elements_text(items)x)<>n or exists(select 1 from jsonb_array_elements_text(items)x where not exists(select 1 from jsonb_array_elements(s#>'{room,roles}')r where r->>'id'=x)) then raise exception '변경된 역할 목록을 확인해주세요.'; end if;
   s:=jsonb_set(s,'{room,members}',(select jsonb_agg(case when m->>'id'=me::text then m||jsonb_build_object('preferences',items,'submitted',true) else m end) from jsonb_array_elements(s#>'{room,members}')m));
 elsif p_action='assign' then
   if not leader or exists(select 1 from jsonb_array_elements(s->'assignments')a where coalesce((a->>'accepted')::boolean,false)) then raise exception '팀장만 수락 시작 전에 배정할 수 있어요.'; end if;
   if jsonb_array_length(s#>'{room,roles}')<>n or exists(select 1 from jsonb_array_elements(s#>'{room,members}')m where not coalesce((m->>'submitted')::boolean,false)) then raise exception '전원이 희망 순위를 제출해야 해요.'; end if;
   with recursive options as (
     select 0 k,array[]::text[] used,'[]'::jsonb matches,0 worst,0 total
     union all
     select o.k+1,o.used||(r->>'id'),o.matches||jsonb_build_array(jsonb_build_object('memberId',m->>'id','role',r->>'id','rank',p.rank)),greatest(o.worst,p.rank::int),o.total+p.rank::int
     from options o cross join lateral (select (s#>'{room,members}')->o.k m) mm
     cross join lateral jsonb_array_elements(s#>'{room,roles}')r
     cross join lateral (select rank from jsonb_array_elements_text(m->'preferences') with ordinality p(id,rank) where id=r->>'id')p
     where o.k<n and not (r->>'id'=any(o.used))
   ), ranked as (select *,dense_rank() over(order by worst,total) pos from options where k=n), optimal as(select *,count(*) over() cnt from ranked where pos=1)
   select matches,worst,total,cnt into chosen,bestworst,bestsum,combos from optimal order by random() limit 1;
   if chosen is null then raise exception '희망 순위를 다시 제출해주세요.'; end if;
   s:=jsonb_set(s,'{result}',jsonb_build_object('matches',chosen,'worstRank',bestworst,'rankSum',bestsum,'optimalCombinationCount',combos));
   select jsonb_agg(m||jsonb_build_object('roleId',r->>'id','role',r->>'name','rank',c->'rank','deadline',r->>'deadline','status',case when i=1 then 'active' else 'waiting' end,'accepted',false) order by i) into items
   from jsonb_array_elements(s#>'{room,roles}') with ordinality rr(r,i)
   join jsonb_array_elements(chosen)c on c->>'role'=r->>'id'
   join jsonb_array_elements(s#>'{room,members}')m on m->>'id'=c->>'memberId';
   s:=jsonb_set(s,'{assignments}',items);
 elsif p_action='accept' then
   if not exists(select 1 from jsonb_array_elements(s->'assignments')a where a->>'id'=me::text) then raise exception '배정 결과를 기다려주세요.'; end if;
   s:=jsonb_set(s,'{assignments}',(select jsonb_agg(case when a->>'id'=me::text then a||'{"accepted":true}'::jsonb else a end) from jsonb_array_elements(s->'assignments')a));
 elsif p_action='start' then
   if not leader then raise exception '팀장만 진행을 시작할 수 있어요.'; end if;
   if jsonb_array_length(s->'assignments')<>n or exists(select 1 from jsonb_array_elements(s->'assignments')a where not coalesce((a->>'accepted')::boolean,false)) then raise exception '전원이 역할을 수락해야 해요.'; end if;
   if s#>>'{room,startedAt}' is null then s:=jsonb_set(s,'{room,startedAt}',to_jsonb(now())); end if;
 elsif p_action in ('complete','remind') then
   if s#>>'{room,startedAt}' is null and s->>'screen'<>'progress' then raise exception '팀장이 진행을 시작해야 해요.'; end if;
   select a,i::int into v,idx from jsonb_array_elements(s->'assignments') with ordinality aa(a,i) where a->>'status'='active';
   if v is null or p_payload->>'roleId' is distinct from v->>'roleId' then raise exception '현재 진행 중인 단계를 확인해주세요.'; end if;
   if p_action='complete' then
     if v->>'id'<>me::text then raise exception '담당자만 단계를 완료할 수 있어요.'; end if;
     s:=jsonb_set(s,array['assignments',(idx-1)::text],v||jsonb_build_object('status','done','completedAt',now()));
     if idx<n then s:=jsonb_set(s,array['assignments',idx::text,'status'],'"active"'); end if;
   else
     if v->>'id'=me::text or (v->>'remindedAt')::timestamptz>now()-interval '24 hours' then raise exception '리마인드는 다른 담당자에게 24시간마다 보낼 수 있어요.'; end if;
     s:=jsonb_set(s,array['assignments',(idx-1)::text,'remindedAt'],to_jsonb(now()));
   end if;
 elsif p_action='finish' then
   if not leader or jsonb_array_length(s->'assignments')<>n or exists(select 1 from jsonb_array_elements(s->'assignments')a where a->>'status'<>'done') then raise exception '팀장이 모든 단계 완료 후 제출을 확인해주세요.'; end if;
   s:=jsonb_set(s,'{room,completedAt}',to_jsonb(now()));
 elsif p_action in ('leave','kick') then
   if s#>>'{room,leaderId}' is not null then raise exception '팀장 결정 후에는 나갈 수 없어요.'; end if;
   target:=case when p_action='leave' then me else (p_payload->>'memberId')::uuid end;
   if p_action='kick' and (not creator or target=me) then raise exception '방 개설자만 다른 팀원을 내보낼 수 있어요.'; end if;
   delete from room_members where room_id=p_room_id and id=target;
   select coalesce(jsonb_agg(m),'[]') into items from jsonb_array_elements(s#>'{room,members}')m where m->>'id'<>target::text;
   if jsonb_array_length(items)=0 then delete from rooms where id=p_room_id;return null; end if;
   if creator and p_action='leave' then
     candidate:=items->0->>'id';
     update room_members set is_creator=(id::text=candidate) where room_id=p_room_id;
     update rooms set creator_user_id=(select user_id from room_members where id::text=candidate) where id=p_room_id;
     select jsonb_agg(m||jsonb_build_object('isCreator',m->>'id'=candidate)) into items from jsonb_array_elements(items)m;
   end if;
   s:=jsonb_set(s,'{room,members}',items);s:=s#-'{room,decision}';
 else raise exception '지원하지 않는 동작입니다.';
 end if;
 s:=s#-'{room,hidden}';
 s:=jsonb_set(s,'{screen}',to_jsonb(case when s#>>'{room,completedAt}' is not null then 'complete' when s#>>'{room,startedAt}' is not null or s->>'screen'='progress' then 'progress' when jsonb_array_length(s->'assignments')>0 then 'results' else 'lobby' end));
 update room_snapshots set state=s,updated_at=now() where room_id=p_room_id;
 return s;
end $$;
revoke all on function public.carry_command(uuid,text,jsonb) from public;
grant execute on function public.carry_command(uuid,text,jsonb) to authenticated;
commit;
