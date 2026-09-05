import { createClient } from "@supabase/supabase-js";
import assert from "node:assert/strict";
const url = process.env.VITE_SUPABASE_URL,
  key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
assert(url && key, "Load .env.local before running");
const clients = [];
async function rpc(c, method, args, denied = false) {
  const { data, error } = await c.rpc(method, args);
  if (denied) {
    assert(error, `${method} should deny`);
    return;
  }
  if (error) throw Error(`${method}: ${error.message}`);
  return data;
}
for (let i = 0; i < 3; i++) {
  const c = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await c.auth.signInAnonymously();
  if (error) throw error;
  clients.push(c);
}
const [a, b, outsider] = clients;
const created = await rpc(a, "create_room", {
  p_name: "[QA] 권한 동시성 검증",
  p_final_deadline: new Date(Date.now() + 864000000).toISOString(),
  p_member_limit: 2,
  p_member_name: "QA개설자",
  p_kakao_id: "qa-not-real",
});
const id = created.room_id;
console.log("QA_ROOM", id);
await rpc(a, "save_room_snapshot", { p_room_id: id, p_state: {} });
const joined = await rpc(b, "join_room", {
  p_invite_code: created.invite_code,
  p_member_name: "QA팀원",
  p_kakao_id: "qa-not-real",
});
const command = (c, action, payload = {}, denied = false) =>
  rpc(
    c,
    "carry_command",
    { p_room_id: id, p_action: action, p_payload: payload },
    denied,
  );
const read = async (c) => {
  const { data, error } = await c
    .from("room_snapshots")
    .select("state")
    .eq("room_id", id);
  if (error) throw error;
  return data[0]?.state;
};
assert.equal(await read(outsider), undefined);
console.log("PASS outsider read denied");
await command(outsider, "mode", { value: "known" }, true);
await command(b, "mode", { value: "known" }, true);
await rpc(
  b,
  "save_room_snapshot",
  { p_room_id: id, p_state: joined.state },
  true,
);
const { error: directError } = await b
  .from("room_members")
  .update({ is_leader: true })
  .eq("id", joined.member_id);
assert(directError);
console.log("PASS direct privilege escalation denied");
await command(a, "mode", { value: "known" });
let s = await command(a, "nominate", { value: joined.member_id });
await command(a, "consent", { version: "stale" }, true);
const version = s.room.decision.version;
s = await command(a, "consent", { version });
assert(!s.room.leaderId);
console.log("PASS one consent does not appoint leader");
await command(a, "consent", { version });
assert.equal((await read(a)).room.decision.consents.length, 1);
s = await command(b, "consent", { version });
assert.equal(s.room.leaderId, joined.member_id);
console.log("PASS all consent appoints nominated member, not creator");
const roles = [0, 1].map((i) => ({
  id: `qa-role-${i}`,
  name: `역할${i}`,
  deliverable: "검증 결과",
  deadline: new Date(Date.now() + (i + 1) * 86400000).toISOString(),
}));
await command(a, "roles", { roles }, true);
await command(b, "roles", { roles });
await command(a, "preferences", { preferences: ["bad", "bad"] }, true);
await Promise.all(
  [a, b].map((c) =>
    command(c, "preferences", { preferences: roles.map((r) => r.id) }),
  ),
);
s = await read(a);
assert(s.room.members.every((m) => m.submitted));
console.log("PASS simultaneous preferences retained");
await command(a, "assign", {}, true);
s = await command(b, "assign");
assert.equal(s.assignments.length, 2);
assert.equal(new Set(s.assignments.map((x) => x.roleId)).size, 2);
await command(b, "start", {}, true);
await Promise.all([a, b].map((c) => command(c, "accept")));
assert((await read(a)).assignments.every((x) => x.accepted));
await command(a, "start", {}, true);
s = await command(b, "start");
assert(s.room.startedAt);
console.log("PASS concurrent acceptance and leader-only start");
for (let i = 0; i < 2; i++) {
  const active = s.assignments.find((x) => x.status === "active");
  const owner = active.id === created.member_id ? a : b,
    other = owner === a ? b : a;
  await command(other, "complete", { roleId: active.roleId }, true);
  if (i === 0) {
    await command(other, "remind", { roleId: active.roleId });
    await command(other, "remind", { roleId: active.roleId }, true);
  }
  s = await command(owner, "complete", { roleId: active.roleId });
}
await command(a, "finish", {}, true);
s = await command(b, "finish");
assert.equal(s.screen, "complete");
assert(s.room.completedAt);
console.log("PASS owner-only completion and leader final submission");
await command(b, "start", {}, true);
console.log(
  "ALL WORKFLOW CHECKS PASSED. Remove only QA_ROOM via admin after testing.",
);
await Promise.all(clients.map((c) => c.removeAllChannels()));
