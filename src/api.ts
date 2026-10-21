import type { Member, RoomRecord } from "./App";

const accessKey = (roomId: string) => `carry-access:${roomId}`;
const request = async <T>(options: RequestInit, query = ""): Promise<T> => {
  const response = await fetch(`/api/rooms${query}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "서버에 연결할 수 없어요.");
  return body as T;
};
const rememberToken = (roomId: string, token: string) =>
  localStorage.setItem(accessKey(roomId), token);
const token = (roomId: string) => localStorage.getItem(accessKey(roomId)) ?? "";

export async function createDatabaseRoom(record: RoomRecord) {
  const data = await request<{ record: RoomRecord; token: string }>({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", record }),
  });
  rememberToken(record.room.id, data.token);
  return data.record;
}

export async function joinDatabaseRoom(code: string, member: Member) {
  const data = await request<{ record: RoomRecord; token: string }>({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "join", code, member }),
  });
  rememberToken(data.record.room.id, data.token);
  return data.record;
}

export const loadDatabaseRoom = (roomId: string) =>
  request<{ record: RoomRecord }>(
    { headers: { Authorization: `Bearer ${token(roomId)}` } },
    `?id=${encodeURIComponent(roomId)}`,
  ).then((data) => data.record);

export const saveDatabaseRoom = (record: RoomRecord) =>
  request<{ record: RoomRecord }>({
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token(record.room.id)}`,
    },
    body: JSON.stringify({ record }),
  }).then((data) => data.record);

export const hasDatabaseAccess = (roomId: string) => Boolean(token(roomId));
