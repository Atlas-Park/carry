import type { RealtimeChannel } from "@supabase/supabase-js";
import { ensureAnonymousSession, supabase } from "./supabase";
import type { Room, RoomRecord } from "./App";

type RpcResult = {
  room_id: string;
  member_id: string;
  invite_code?: string;
  created_at?: string;
  state?: RoomRecord | null;
};

export type JoinDetails = {
  code: string;
  name: string;
  phone?: string;
  kakao?: string;
  email?: string;
};

const messageFor = (error: { message?: string } | null, fallback: string) => {
  const message = error?.message?.replace(/^.*?: /, "").trim();
  return message || fallback;
};

export async function createRemoteRoom(draft: Room): Promise<Room> {
  if (!supabase) return draft;
  await ensureAnonymousSession();
  const creator = draft.members[0];
  const { data, error } = await supabase.rpc("create_room", {
    p_name: draft.name,
    p_final_deadline: draft.deadline,
    p_member_limit: draft.size,
    p_member_name: creator.name,
    p_phone: creator.contact.phone ?? null,
    p_kakao_id: creator.contact.kakao ?? null,
    p_email: creator.contact.email ?? null,
  });
  if (error) throw new Error(messageFor(error, "방을 만들지 못했어요."));
  const remote = data as RpcResult;
  const room: Room = {
    ...draft,
    id: remote.room_id,
    code: remote.invite_code!,
    createdAt: remote.created_at ?? draft.createdAt,
    members: [{ ...creator, id: remote.member_id }],
  };
  await saveRemoteRecord({
    room,
    result: null,
    assignments: [],
    screen: "lobby",
    lastAccessedAt: new Date().toISOString(),
  });
  return room;
}

export async function joinRemoteRoom(details: JoinDetails) {
  if (!supabase) throw new Error("서버 연결이 설정되지 않았어요.");
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("join_room", {
    p_invite_code: details.code,
    p_member_name: details.name,
    p_phone: details.phone ?? null,
    p_kakao_id: details.kakao ?? null,
    p_email: details.email ?? null,
  });
  if (error) throw new Error(messageFor(error, "방에 들어가지 못했어요."));
  const remote = data as RpcResult;
  if (!remote.state)
    throw new Error(
      "방 데이터가 아직 준비되지 않았어요. 잠시 후 다시 시도해주세요.",
    );
  return { record: remote.state, memberId: remote.member_id };
}

export async function saveRemoteRecord(record: RoomRecord) {
  if (!supabase || record.room.id.startsWith("mock-")) return;
  const state: RoomRecord = {
    ...record,
    room: {
      ...record.room,
      members: record.room.members.map(({ isMe: _isMe, ...member }) => member),
    },
    assignments: record.assignments.map(
      ({ isMe: _isMe, ...assignment }) => assignment,
    ),
  };
  const { error } = await supabase.rpc("save_room_snapshot", {
    p_room_id: record.room.id,
    p_state: state,
  });
  if (error)
    throw new Error(messageFor(error, "변경 사항을 저장하지 못했어요."));
}

export async function loadRemoteRecords() {
  if (!supabase) return [];
  const session = await ensureAnonymousSession();
  if (!session) return [];
  const { data: memberships, error: membershipError } = await supabase
    .from("room_members")
    .select("id, room_id")
    .eq("user_id", session.user.id);
  if (membershipError) throw membershipError;
  if (!memberships?.length) return [];
  const memberByRoom = new Map(
    memberships.map((m) => [m.room_id as string, m.id as string]),
  );
  const { data: snapshots, error } = await supabase
    .from("room_snapshots")
    .select("room_id, state, updated_at")
    .in("room_id", [...memberByRoom.keys()]);
  if (error) throw error;
  return (snapshots ?? []).map((row) => ({
    roomId: row.room_id as string,
    memberId: memberByRoom.get(row.room_id as string)!,
    record: row.state as RoomRecord,
  }));
}

export function subscribeToRoomSnapshots(
  onRecord: (roomId: string, record: RoomRecord) => void,
): RealtimeChannel | null {
  if (!supabase) return null;
  return supabase
    .channel("carry-room-snapshots")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "room_snapshots" },
      (payload) => {
        const row = payload.new as { room_id?: string; state?: RoomRecord };
        if (row.room_id && row.state) onRecord(row.room_id, row.state);
      },
    )
    .subscribe();
}
