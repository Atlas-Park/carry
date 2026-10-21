import { neon } from "@neondatabase/serverless";
import { createHash, randomBytes } from "node:crypto";

type Contact = { phone?: string; kakao?: string; email?: string };
type Member = {
  id: string;
  name: string;
  contact: Contact;
  isMe?: boolean;
  isCreator?: boolean;
  isHost?: boolean;
};
type RecordData = {
  room: {
    id: string;
    code: string;
    name: string;
    deadline: string;
    size: number;
    leaderId?: string;
    startedAt?: string;
    completedAt?: string;
    createdAt?: string;
    members: Member[];
    roles: Array<{
      id: string;
      name: string;
      deliverable: string;
      deadline: string;
    }>;
    [key: string]: unknown;
  };
  assignments: Array<{
    id: string;
    roleId: string;
    rank: number;
    deadline: string;
    status: string;
    accepted?: boolean;
    remindedAt?: string;
    completedAt?: string;
    isMe?: boolean;
    [key: string]: unknown;
  }>;
  screen: string;
  [key: string]: unknown;
};
type Request = {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body?: any;
};
type Response = {
  status(code: number): Response;
  json(value: unknown): void;
  setHeader(name: string, value: string): void;
};

const schema = [
  `CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, code VARCHAR(6) NOT NULL UNIQUE, name VARCHAR(40) NOT NULL, final_deadline TIMESTAMPTZ NOT NULL, capacity SMALLINT NOT NULL CHECK (capacity BETWEEN 2 AND 8), leader_id TEXT, workflow_screen TEXT NOT NULL DEFAULT 'lobby', state JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS room_members (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, name VARCHAR(20) NOT NULL, phone VARCHAR(20), kakao VARCHAR(40), email VARCHAR(100), is_creator BOOLEAN NOT NULL DEFAULT FALSE, is_host BOOLEAN NOT NULL DEFAULT FALSE, access_token_hash CHAR(64), joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS room_members_name_unique ON room_members (room_id, LOWER(name))`,
  `CREATE INDEX IF NOT EXISTS room_members_room_idx ON room_members(room_id)`,
  `CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, name TEXT NOT NULL, deliverable TEXT NOT NULL DEFAULT '', personal_deadline TIMESTAMPTZ NOT NULL, position SMALLINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS roles_room_idx ON roles(room_id)`,
  `CREATE TABLE IF NOT EXISTS assignments (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES room_members(id) ON DELETE CASCADE, role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE, preference_rank SMALLINT NOT NULL, personal_deadline TIMESTAMPTZ NOT NULL, status TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'done')), accepted BOOLEAN NOT NULL DEFAULT FALSE, reminded_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, PRIMARY KEY (room_id, member_id))`,
];

const connection = process.env.DATABASE_URL;
const sql = connection ? neon(connection) : null;
let initialized: Promise<void> | null = null;
const database = async () => {
  if (!sql) throw new Error("DATABASE_URL이 설정되지 않았어요.");
  initialized ??= (async () => {
    for (const statement of schema) await sql.query(statement, []);
  })();
  await initialized;
  return sql;
};
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const clean = (record: RecordData): RecordData => ({
  ...record,
  room: {
    ...record.room,
    members: record.room.members.map(({ isMe: _isMe, ...member }) => member),
  },
  assignments: record.assignments.map(({ isMe: _isMe, ...item }) => item),
});
const error = (response: Response, status: number, message: string) =>
  response.status(status).json({ error: message });
const bearer = (request: Request) =>
  String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
const validContact = (contact: Contact) =>
  Boolean(contact.phone || contact.kakao || contact.email) &&
  (!contact.phone || /^[0-9-]{3,20}$/.test(contact.phone)) &&
  (!contact.kakao || contact.kakao.length <= 40) &&
  (!contact.email ||
    (contact.email.length <= 100 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)));
const validMember = (member: Member) =>
  Boolean(member?.id && member.name?.trim()) &&
  member.name.trim().length <= 20 &&
  validContact(member.contact ?? {});
const validRecord = (record: RecordData) => {
  const room = record?.room;
  return Boolean(
    room?.id &&
    /^[A-Z0-9]{6}$/.test(room.code) &&
    room.name?.trim() &&
    room.name.length <= 40 &&
    Number.isInteger(room.size) &&
    room.size >= 2 &&
    room.size <= 8 &&
    Number.isFinite(Date.parse(room.deadline)) &&
    room.members?.length >= 1 &&
    room.members.length <= room.size &&
    room.members.every(validMember) &&
    Array.isArray(room.roles) &&
    room.roles.length <= room.size &&
    Array.isArray(record.assignments),
  );
};

async function findRoom(value: string) {
  const db = await database();
  const rows = await db`
    SELECT state FROM rooms
    WHERE id = ${value} OR code = ${value.toUpperCase()}
    LIMIT 1
  `;
  return (rows[0]?.state as RecordData | undefined) ?? null;
}

async function canAccess(roomId: string, token: string) {
  if (!token) return false;
  const db = await database();
  const rows = await db`
    SELECT 1 FROM room_members
    WHERE room_id = ${roomId} AND access_token_hash = ${hash(token)}
    LIMIT 1
  `;
  return rows.length > 0;
}

async function saveRecord(input: RecordData) {
  const db = await database();
  const record = clean(input);
  const room = record.room;
  await db`
    INSERT INTO rooms (id, code, name, final_deadline, capacity, leader_id, workflow_screen, state, created_at, updated_at, started_at, completed_at)
    VALUES (${room.id}, ${room.code}, ${room.name}, ${room.deadline}, ${room.size}, ${room.leaderId ?? null}, ${record.screen}, ${JSON.stringify(record)}::jsonb, ${room.createdAt ?? new Date().toISOString()}, NOW(), ${room.startedAt ?? null}, ${room.completedAt ?? null})
    ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code, name=EXCLUDED.name, final_deadline=EXCLUDED.final_deadline, capacity=EXCLUDED.capacity, leader_id=EXCLUDED.leader_id, workflow_screen=EXCLUDED.workflow_screen, state=EXCLUDED.state, updated_at=NOW(), started_at=EXCLUDED.started_at, completed_at=EXCLUDED.completed_at
  `;
  for (const member of room.members)
    await db`
      INSERT INTO room_members (id, room_id, name, phone, kakao, email, is_creator, is_host)
      VALUES (${member.id}, ${room.id}, ${member.name}, ${member.contact.phone ?? null}, ${member.contact.kakao ?? null}, ${member.contact.email ?? null}, ${Boolean(member.isCreator)}, ${Boolean(member.isHost)})
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, kakao=EXCLUDED.kakao, email=EXCLUDED.email, is_creator=EXCLUDED.is_creator, is_host=EXCLUDED.is_host
    `;
  const memberIds = room.members.map((member) => member.id);
  await db.query(
    `DELETE FROM room_members WHERE room_id = $1 AND NOT (id = ANY($2::text[]))`,
    [room.id, memberIds],
  );
  await db`DELETE FROM assignments WHERE room_id = ${room.id}`;
  await db`DELETE FROM roles WHERE room_id = ${room.id}`;
  for (let position = 0; position < room.roles.length; position += 1) {
    const role = room.roles[position];
    await db`
      INSERT INTO roles (id, room_id, name, deliverable, personal_deadline, position)
      VALUES (${role.id}, ${room.id}, ${role.name}, ${role.deliverable}, ${role.deadline}, ${position})
    `;
  }
  for (const item of record.assignments)
    await db`
      INSERT INTO assignments (room_id, member_id, role_id, preference_rank, personal_deadline, status, accepted, reminded_at, completed_at)
      VALUES (${room.id}, ${item.id}, ${item.roleId}, ${item.rank}, ${item.deadline}, ${item.status}, ${Boolean(item.accepted)}, ${item.remindedAt ?? null}, ${item.completedAt ?? null})
    `;
  return record;
}

export default async function handler(request: Request, response: Response) {
  try {
    if (request.method === "GET") {
      const id = String(request.query.id ?? "");
      const record = await findRoom(id);
      if (!record) return error(response, 404, "방을 찾을 수 없어요.");
      if (!(await canAccess(record.room.id, bearer(request))))
        return error(response, 403, "이 방에 접근할 권한이 없어요.");
      return response.status(200).json({ record });
    }
    if (request.method === "POST" && request.body?.action === "create") {
      const record = request.body.record as RecordData;
      const creator = record?.room?.members?.[0];
      if (!validRecord(record) || !creator)
        return error(response, 400, "방 정보가 올바르지 않아요.");
      const saved = await saveRecord(record);
      const token = newToken();
      const db = await database();
      await db`UPDATE room_members SET access_token_hash = ${hash(token)} WHERE id = ${creator.id}`;
      return response.status(201).json({ record: saved, token });
    }
    if (request.method === "POST" && request.body?.action === "join") {
      const code = String(request.body.code ?? "")
        .trim()
        .toUpperCase();
      const member = request.body.member as Member;
      const record = await findRoom(code);
      if (!record) return error(response, 404, "유효하지 않은 초대 코드예요.");
      if (!validMember(member))
        return error(response, 400, "참가자 정보가 올바르지 않아요.");
      if (record.room.roles.length || record.room.leaderId)
        return error(
          response,
          409,
          "이미 역할 설정이 시작되어 참가할 수 없어요.",
        );
      if (record.room.members.length >= record.room.size)
        return error(response, 409, "이미 모든 팀원이 참가한 방이에요.");
      if (
        record.room.members.some(
          (item) =>
            item.name.toLowerCase() === member.name.trim().toLowerCase(),
        )
      )
        return error(response, 409, "이미 사용 중인 이름이에요.");
      record.room.members.push({ ...member, name: member.name.trim() });
      record.lastAccessedAt = new Date().toISOString();
      const saved = await saveRecord(record);
      const token = newToken();
      const db = await database();
      await db`UPDATE room_members SET access_token_hash = ${hash(token)} WHERE id = ${member.id}`;
      return response.status(201).json({ record: saved, token });
    }
    if (request.method === "PUT") {
      const record = request.body?.record as RecordData;
      if (!validRecord(record))
        return error(response, 400, "저장할 방 정보가 없어요.");
      if (!(await canAccess(record.room.id, bearer(request))))
        return error(response, 403, "이 방을 수정할 권한이 없어요.");
      return response.status(200).json({ record: await saveRecord(record) });
    }
    response.setHeader("Allow", "GET, POST, PUT");
    return error(response, 405, "지원하지 않는 요청이에요.");
  } catch (cause) {
    console.error(cause);
    const message =
      cause instanceof Error
        ? cause.message
        : "데이터베이스 오류가 발생했어요.";
    if (message.includes("rooms_code_key"))
      return error(response, 409, "초대 코드가 겹쳤어요. 다시 만들어주세요.");
    if (message.includes("room_members_name_unique"))
      return error(response, 409, "이미 사용 중인 이름이에요.");
    if (message.includes("DATABASE_URL")) return error(response, 500, message);
    return error(
      response,
      500,
      "서버에 저장하지 못했어요. 잠시 후 다시 시도해주세요.",
    );
  }
}
