import { useEffect, useId, useRef, useState } from "react";
import { SortableList } from "./SortableList";
import { PwaTools, inviteCode } from "./PwaTools";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Clock3,
  GripVertical,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  calculateFairAssignment,
  createRoleDeadlines,
  type FairAssignmentResult,
} from "./assignment";
import {
  createRemoteRoom,
  roomCommand,
  joinRemoteRoom,
  loadRemoteRecords,
  subscribeToRoomSnapshots,
} from "./backend";
import {
  ensureAnonymousSession,
  isSupabaseConfigured,
  supabase,
} from "./supabase";
export type Screen =
  | "home"
  | "create"
  | "join"
  | "lobby"
  | "assigning"
  | "results"
  | "progress"
  | "complete";
export type Contact = { phone?: string; kakao?: string; email?: string };
export type Role = {
  id: string;
  name: string;
  deliverable: string;
  deadline: string;
};
export type Member = {
  id: string;
  name: string;
  isMe?: boolean;
  isCreator?: boolean;
  isHost?: boolean;
  contact: Contact;
  preferences?: string[];
  submitted?: boolean;
  accepted?: boolean;
};
export type Room = {
  id: string;
  name: string;
  deadline: string;
  createdAt?: string;
  size: number;
  roles: Role[];
  code: string;
  members: Member[];
  leaderId?: string;
  completedAt?: string;
  hidden?: boolean;
  startedAt?: string;
  decision?: {
    mode?: "known" | "random";
    candidate?: string;
    version?: string;
    consents?: string[];
  };
};
export type RoomRecord = {
  revision?: number;
  room: Room;
  result: FairAssignmentResult | null;
  assignments: Assignment[];
  screen: Screen;
  lastAccessedAt: string;
};
type CarryStore = {
  version: 2;
  rooms: Record<string, RoomRecord>;
  currentRoomId: string | null;
};
export type Assignment = Member & {
  roleId: string;
  role: string;
  rank: number;
  deadline: string;
  status: "waiting" | "active" | "done";
  remindedAt?: string;
  completedAt?: string;
};
const DEFAULT_ROLES = ["자료조사", "보고서 작성", "PPT 제작", "발표"];
const mockMembers: Member[] = [
  {
    id: "mock-member-11",
    name: "민지",
    isHost: true,
    contact: { kakao: "minji_24" },
  },
  { id: "mock-member-12", name: "서준", contact: { phone: "010-2345-6789" } },
  {
    id: "mock-member-13",
    name: "지우",
    contact: { email: "jiwoo@example.com" },
  },
];
const mockEnd = new Date(Date.now() + 5 * 86400000).toISOString(),
  mockDates = createRoleDeadlines(mockEnd, 4, Date.now() - 86400000);
const MOCK_ROOM: Room = {
  id: "mock-carry1",
  name: "마케팅 전략 팀플",
  deadline: mockEnd,
  createdAt: new Date(Date.now() - 86400000).toISOString(),
  size: 4,
  roles: DEFAULT_ROLES.map((name, i) => ({
    id: `mock-role-${i + 1}`,
    name,
    deliverable: `${name} 결과물 완성`,
    deadline: mockDates[i],
  })),
  code: "CARRY1",
  leaderId: "mock-member-11",
  members: mockMembers,
};
const demoNames = ["민지", "서준", "지우", "하린", "도윤", "수아"];
const DEV = false;
const emptyStore = (): CarryStore => ({
  version: 2,
  rooms: {},
  currentRoomId: null,
});
const migrateRecord = (raw: any): RoomRecord | null => {
  if (!raw?.room || typeof raw.room.name !== "string") return null;
  const legacyRoles = Array.isArray(raw.room.roles) ? raw.room.roles : [];
  const roles: Role[] = legacyRoles.map(
    (role: string | Partial<Role>, i: number) =>
      typeof role === "string"
        ? {
            id: `legacy-role-${i}-${role}`,
            name: role,
            deliverable: raw.room.deliverables?.[role] ?? "",
            deadline:
              raw.room.roleDeadlines?.[role] ??
              createRoleDeadlines(
                raw.room.deadline,
                Math.max(1, legacyRoles.length),
              )[i],
          }
        : {
            id: role.id || crypto.randomUUID(),
            name: role.name || `역할 ${i + 1}`,
            deliverable: role.deliverable || "",
            deadline:
              role.deadline ||
              createRoleDeadlines(
                raw.room.deadline,
                Math.max(1, legacyRoles.length),
              )[i],
          },
  );
  const room: Room = {
    ...raw.room,
    id: raw.room.id || crypto.randomUUID(),
    roles,
    leaderId: raw.room.leaderId ? String(raw.room.leaderId) : undefined,
    members: Array.isArray(raw.room.members)
      ? raw.room.members.map((member: any) => ({
          ...member,
          id: String(member.id),
        }))
      : [],
  };
  const assignments: Assignment[] = (
    Array.isArray(raw.assignments) ? raw.assignments : []
  ).map((a: any) => {
    const found = roles.find((r) => r.id === a.roleId || r.name === a.role);
    return {
      ...a,
      id: String(a.id),
      roleId: found?.id ?? a.roleId ?? crypto.randomUUID(),
    };
  });
  return {
    room,
    revision: raw.revision ?? 0,
    result: raw.result ?? null,
    assignments,
    screen: raw.screen ?? "lobby",
    lastAccessedAt: raw.lastAccessedAt ?? new Date().toISOString(),
  };
};
const loadStore = (): CarryStore => {
  try {
    const modern = JSON.parse(localStorage.getItem("carry-store") || "null");
    if (modern?.rooms && typeof modern.rooms === "object") {
      const rooms = Object.fromEntries(
        Object.entries(modern.rooms)
          .map(([id, value]) => [id, migrateRecord(value)])
          .filter((entry): entry is [string, RoomRecord] => Boolean(entry[1])),
      );
      return {
        version: 2,
        rooms,
        currentRoomId: rooms[modern.currentRoomId]
          ? modern.currentRoomId
          : null,
      };
    }
    const legacy = JSON.parse(localStorage.getItem("carry-active") || "null");
    const record = migrateRecord(legacy);
    if (record)
      return {
        version: 2,
        rooms: { [record.room.id]: record },
        currentRoomId: record.room.id,
      };
  } catch {
    // Corrupted or obsolete browser data must never prevent the app from opening.
  }
  return emptyStore();
};
const INVITE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const generateInviteCode = (used: Set<string>) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = Array.from(
      { length: 6 },
      () => INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)],
    ).join("");
    if (code !== "CARRY1" && !used.has(code)) return code;
  }
  return crypto
    .randomUUID()
    .replace(/[^A-HJ-KM-NP-Z2-9]/gi, "A")
    .slice(0, 6)
    .toUpperCase();
};
const viewerIdFor = (roomId: string) => {
  try {
    const viewers = JSON.parse(sessionStorage.getItem("carry-viewers") || "{}");
    return typeof viewers[roomId] === "string" ? viewers[roomId] : null;
  } catch {
    return null;
  }
};
const rememberViewer = (roomId: string, memberId: string) => {
  try {
    const viewers = JSON.parse(sessionStorage.getItem("carry-viewers") || "{}");
    sessionStorage.setItem(
      "carry-viewers",
      JSON.stringify({ ...viewers, [roomId]: memberId }),
    );
  } catch {
    // Private browsing may reject storage; the current in-memory state still works.
  }
};
const hydrateViewer = (record: RoomRecord): RoomRecord => {
  const viewerId = viewerIdFor(record.room.id);
  if (viewerId === null) return record;
  return {
    ...record,
    room: {
      ...record.room,
      members: record.room.members.map((member) => ({
        ...member,
        isMe: member.id === viewerId,
      })),
    },
    assignments: record.assignments.map((assignment) => ({
      ...assignment,
      isMe: assignment.id === viewerId,
    })),
  };
};
const formatDate = (v: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(v));
const toLocalDateTimeInput = (value: string) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const countdown = (target: string, now = Date.now()) => {
  const d = Math.max(0, new Date(target).getTime() - now),
    days = Math.floor(d / 86400000),
    h = Math.floor(d / 3600000) % 24,
    m = Math.floor(d / 60000) % 60,
    s = Math.floor(d / 1000) % 60;
  return days ? `${days}일 ${h}시간 ${m}분` : `${h}시간 ${m}분 ${s}초`;
};
const shuffled = <T,>(items: T[]) => {
  const a = [...items];
  for (let i = a.length - 1; i; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
export function App() {
  const applyingRemote = useRef(false);
  const [connection, setConnection] = useState(
    isSupabaseConfigured ? "내 방을 확인하고 있어요…" : "",
  );
  const revisions = useRef<Record<string, number>>({});
  const currentRoomIdRef = useRef<string | null>(null);
  const initial = useRef(loadStore()).current,
    rawInitialRecord = initial.currentRoomId
      ? initial.rooms[initial.currentRoomId]
      : null,
    initialRecord =
      !isSupabaseConfigured && rawInitialRecord
        ? hydrateViewer(rawInitialRecord)
        : null;
  const [screen, setScreen] = useState<Screen>(inviteCode() ? "join" : "home"),
    [records, setRecords] = useState<Record<string, RoomRecord>>(initial.rooms),
    [currentRoomId, setCurrentRoomId] = useState<string | null>(
      initial.currentRoomId,
    ),
    [room, setRoom] = useState<Room | null>(initialRecord?.room ?? null),
    [result, setResult] = useState<FairAssignmentResult | null>(
      initialRecord?.result ?? null,
    ),
    [assignments, setAssignments] = useState<Assignment[]>(
      initialRecord?.assignments ?? [],
    ),
    [confirm, setConfirm] = useState<"retry" | "roles" | null>(null),
    [editing, setEditing] = useState(false),
    [toast, setToast] = useState("");
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let alive = true;
    let channel: ReturnType<typeof subscribeToRoomSnapshots> = null;
    const applyRemoteRecord = (roomId: string, rawRecord: RoomRecord) => {
      const migrated = migrateRecord(rawRecord);
      if (!migrated) return;
      if ((migrated.revision ?? 0) < (revisions.current[roomId] ?? 0)) return;
      revisions.current[roomId] = migrated.revision ?? 0;
      setRecords((previous) => ({ ...previous, [roomId]: migrated }));
      if (currentRoomIdRef.current === roomId) {
        const next = hydrateViewer(migrated);
        applyingRemote.current = true;
        setRoom(next.room);
        setResult(next.result);
        setAssignments(next.assignments);
        setScreen((current) =>
          ["home", "create", "join"].includes(current) ? current : next.screen,
        );
      }
    };
    const onRemote = (event: Event) => {
      const { id, record } = (
        event as CustomEvent<{ id: string; record: RoomRecord | null }>
      ).detail;
      if (record) applyRemoteRecord(id, record);
      else
        setRecords((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
    };
    window.addEventListener("carry-remote", onRemote);
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || !alive) return;
      refreshing = true;
      try {
        await ensureAnonymousSession();
        const remoteRooms = await loadRemoteRecords();
        if (!alive) return;
        setConnection("");
        const loaded: Record<string, RoomRecord> = {};
        for (const item of remoteRooms) {
          rememberViewer(item.roomId, item.memberId);
          const migrated = migrateRecord(item.record);
          if (migrated) loaded[item.roomId] = migrated;
        }
        setRecords((previous) =>
          Object.fromEntries(
            Object.entries(loaded).map(([id, record]) => [
              id,
              (previous[id]?.revision ?? 0) > (record.revision ?? 0)
                ? previous[id]
                : record,
            ]),
          ),
        );
        const activeId = currentRoomIdRef.current;
        if (activeId && loaded[activeId])
          applyRemoteRecord(activeId, loaded[activeId]);
        else if (activeId) {
          setRoom(null);
          setCurrentRoomId(null);
          setScreen((current) =>
            ["create", "join"].includes(current) ? current : "home",
          );
        }
        if (!channel) channel = subscribeToRoomSnapshots(applyRemoteRecord);
      } catch (error) {
        console.error("Supabase startup failed", error);
        setConnection(
          error instanceof Error
            ? error.message
            : "연결을 확인해주세요. 이전 목록을 유지하고 있어요.",
        );
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const onFocus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("carry-refresh", refresh);
    const poll = setInterval(onFocus, 15000);
    return () => {
      alive = false;
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("carry-refresh", refresh);
      window.removeEventListener("carry-remote", onRemote);
      if (channel && supabase) void supabase.removeChannel(channel);
    };
  }, []);
  useEffect(() => {
    currentRoomIdRef.current = currentRoomId;
  }, [currentRoomId]);
  // Browser back returns to the list, never to an obsolete workflow stage.
  const inDetail = screen !== "home";
  useEffect(() => {
    if (inDetail && !history.state?.carryDetail)
      history.pushState({ carryDetail: true }, "", location.href);
    if (!inDetail && history.state?.carryDetail)
      history.replaceState(null, "", location.pathname);
  }, [inDetail]);
  useEffect(() => {
    const back = () => setScreen("home");
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  const home = () => {
    setScreen("home");
  };
  useEffect(() => {
    if (!room || !currentRoomId) return;
    if (isSupabaseConfigured) return;
    const skipRemoteSave = applyingRemote.current;
    applyingRemote.current = false;
    setRecords((previousRooms) => {
      const previous = previousRooms[currentRoomId];
      const storedScreen: Screen = [
        "lobby",
        "assigning",
        "results",
        "progress",
        "complete",
      ].includes(screen)
        ? screen
        : (previous?.screen ?? "lobby");
      const record: RoomRecord = {
        room,
        result,
        assignments,
        screen: storedScreen,
        lastAccessedAt: new Date().toISOString(),
      };
      const next = { ...previousRooms, [currentRoomId]: record };
      localStorage.setItem(
        "carry-store",
        JSON.stringify({ version: 2, rooms: next, currentRoomId }),
      );

      return next;
    });
  }, [room, result, assignments, screen, currentRoomId]);
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    try {
      localStorage.setItem(
        "carry-store",
        JSON.stringify({ version: 2, rooms: records, currentRoomId }),
      );
    } catch {
      /* Server remains authoritative. */
    }
  }, [records, currentRoomId]);
  useEffect(() => {
    if (isSupabaseConfigured) return;
    const sync = (e: StorageEvent) => {
      if (e.key !== "carry-store" || !e.newValue) return;
      try {
        const parsed = JSON.parse(e.newValue);
        if (!parsed?.rooms || typeof parsed.rooms !== "object") return;
        const nextRooms = Object.fromEntries(
          Object.entries(parsed.rooms)
            .map(([id, value]) => [id, migrateRecord(value)])
            .filter((entry): entry is [string, RoomRecord] =>
              Boolean(entry[1]),
            ),
        );
        setRecords(nextRooms);
        if (currentRoomId && nextRooms[currentRoomId]) {
          const r = hydrateViewer(nextRooms[currentRoomId]);
          applyingRemote.current = true;
          setRoom(r.room);
          setResult(r.result);
          setAssignments(r.assignments);
        }
      } catch {
        /* ignore invalid external writes */
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [currentRoomId]);
  const openRecord = (id: string) => {
    const stored = records[id];
    const record = stored ? hydrateViewer(stored) : null;
    if (!record) return;
    setCurrentRoomId(id);
    setRoom(record.room);
    setResult(record.result);
    setAssignments(record.assignments);
    setScreen(
      record.room.completedAt
        ? "complete"
        : !["lobby", "assigning", "results", "progress"].includes(record.screen)
          ? "lobby"
          : record.screen,
    );
  };
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const run = async (action: string, payload: Record<string, unknown> = {}) => {
    if (!room || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setToast("");
    try {
      await roomCommand(room.id, action, payload);
      return true;
    } catch (e) {
      setToast(
        e instanceof Error
          ? e.message
          : "저장하지 못했어요. 다시 시도해주세요.",
      );
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const changeRoom = (next: Room) => {
    if (!room) return Promise.resolve(false);
    const d = next.decision,
      old = room.decision;
    if (JSON.stringify(d) !== JSON.stringify(old)) {
      if (!d?.mode) return run("reset_decision");
      if (d.mode !== old?.mode) return run("mode", { value: d.mode });
      if (d.candidate !== old?.candidate)
        return run(d.candidate ? "nominate" : "reject", {
          value: d.candidate,
          version: old?.version,
        });
      return run("consent", { version: old?.version });
    } else if (JSON.stringify(next.roles) !== JSON.stringify(room.roles))
      return run("roles", { roles: next.roles });
    else if (next.members.length < room.members.length)
      return run("kick", {
        memberId: room.members.find(
          (m) => !next.members.some((x) => x.id === m.id),
        )?.id,
      });
    const m = next.members.find((m) => m.isMe),
      oldMe = room.members.find((m) => m.isMe);
    if (
      m?.preferences &&
      (JSON.stringify(m.preferences) !== JSON.stringify(oldMe?.preferences) ||
        m.submitted !== oldMe?.submitted)
    )
      return run("preferences", { preferences: m.preferences });
    return Promise.resolve(true);
  };
  const changeAssignments: React.Dispatch<
    React.SetStateAction<Assignment[]>
  > = (value) => {
    const next = typeof value === "function" ? value(assignments) : value;
    const completed = next.find(
      (a) =>
        a.status === "done" &&
        assignments.find((x) => x.id === a.id)?.status !== "done",
    );
    const reminded = next.find(
      (a) =>
        a.remindedAt !== assignments.find((x) => x.id === a.id)?.remindedAt,
    );
    if (completed) void run("complete", { roleId: completed.roleId });
    else if (reminded) void run("remind", { roleId: reminded.roleId });
  };
  const assign = () => {
    void run("assign");
  };
  const copy = (s: string) => {
    navigator.clipboard?.writeText(s).catch(() => {});
    setToast("복사했어요");
    setTimeout(() => setToast(""), 1500);
  };
  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <button className="brand" onClick={home}>
          Carry<span>.</span>
        </button>
        {screen !== "home" && (
          <button className="icon-button" onClick={home} aria-label="뒤로 가기">
            <ArrowLeft size={20} />
          </button>
        )}
      </header>
      <section className="page" aria-busy={busy}>
        {connection && (
          <p role="status">
            {connection}{" "}
            <button
              onClick={() => window.dispatchEvent(new Event("carry-refresh"))}
            >
              다시 확인
            </button>
          </p>
        )}
        <PwaTools
          code={
            room && !["home", "create", "join"].includes(screen)
              ? room.code
              : undefined
          }
        />
        {busy && <p role="status">저장 중…</p>}
        {screen === "home" && (
          <Home
            records={records}
            open={openRecord}
            create={() => setScreen("create")}
            join={() => setScreen("join")}
          />
        )}{" "}
        {screen === "create" && (
          <Create
            usedCodes={new Set(Object.values(records).map((r) => r.room.code))}
            done={(r) => {
              const viewer = r.members.find((member) => member.isMe);
              if (viewer) rememberViewer(r.id, viewer.id);
              setRecords((previous) => ({
                ...previous,
                [r.id]: {
                  room: r,
                  result: null,
                  assignments: [],
                  screen: "lobby",
                  lastAccessedAt: new Date().toISOString(),
                },
              }));
              setCurrentRoomId(r.id);
              setRoom(r);
              setResult(null);
              setAssignments([]);
              setScreen("lobby");
            }}
          />
        )}{" "}
        {screen === "join" && (
          <Join
            records={records}
            done={(r, joinedRecord) => {
              const viewer = r.members.find((member) => member.isMe);
              if (viewer) rememberViewer(r.id, viewer.id);
              if (joinedRecord)
                setRecords((previous) => ({
                  ...previous,
                  [r.id]: joinedRecord,
                }));
              setCurrentRoomId(r.id);
              setRoom(r);
              setResult(joinedRecord?.result ?? records[r.id]?.result ?? null);
              setAssignments(
                joinedRecord?.assignments ?? records[r.id]?.assignments ?? [],
              );
              setScreen(joinedRecord?.screen ?? "lobby");
            }}
          />
        )}{" "}
        {screen === "lobby" && room && (
          <Lobby
            room={room}
            setRoom={changeRoom}
            assign={assign}
            editing={editing}
            setEditing={setEditing}
            roleEdit={() =>
              room.members.some((m) => m.submitted)
                ? setConfirm("roles")
                : setEditing(true)
            }
            copy={copy}
            leave={() => {
              void run("leave").then((ok) => {
                if (!ok) return;
                setRecords((previous) => {
                  const next = { ...previous };
                  delete next[room.id];
                  return next;
                });
                setRoom(null);
                setCurrentRoomId(null);
                setScreen("home");
              });
            }}
          />
        )}{" "}
        {screen === "assigning" && <Assigning />}{" "}
        {screen === "results" && room && result && (
          <Results
            room={room}
            result={result}
            assignments={assignments}
            accept={() => {
              void run("accept");
            }}
            acceptDemo={() => {}}
            start={() => {
              void run("start");
            }}
            retry={() => setConfirm("retry")}
          />
        )}{" "}
        {screen === "progress" && room && (
          <Progress
            room={room}
            assignments={assignments}
            setAssignments={changeAssignments}
            home={home}
            finish={() => {
              void run("finish");
            }}
          />
        )}
        {screen === "complete" && room?.completedAt && (
          <Completed
            room={room}
            home={home}
            hide={() => {
              const hidden = JSON.parse(
                localStorage.getItem("carry-hidden") || "{}",
              );
              localStorage.setItem(
                "carry-hidden",
                JSON.stringify({ ...hidden, [room.id]: true }),
              );
              setRoom({ ...room, hidden: true });
              setScreen("home");
            }}
          />
        )}
      </section>
      {confirm === "retry" && (
        <Confirm
          title="역할을 다시 배정할까요?"
          body="현재 최적 조건을 만족하는 조합 안에서 결과가 다시 결정돼요."
          action="다시 배정"
          cancel={() => setConfirm(null)}
          proceed={() => {
            setConfirm(null);
            assign();
          }}
        />
      )}
      {confirm === "roles" && (
        <Confirm
          title="역할을 변경할까요?"
          body="역할 구성이 실제로 달라지는 경우에만 모든 팀원의 희망 순위가 초기화됩니다."
          action="역할 변경"
          cancel={() => setConfirm(null)}
          proceed={() => {
            setConfirm(null);
            setEditing(true);
          }}
        />
      )}
      {toast && (
        <div className="toast">
          <Check size={17} />
          {toast}
        </div>
      )}
    </main>
  );
}
function Home({
  create,
  join,
  records,
  open,
}: {
  create: () => void;
  join: () => void;
  records: Record<string, RoomRecord>;
  open: (id: string) => void;
}) {
  const visible = Object.values(records)
      .filter((r) => {
        try {
          return !JSON.parse(localStorage.getItem("carry-hidden") || "{}")[
            r.room.id
          ];
        } catch {
          return true;
        }
      })
      .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt)),
    activeRecords = visible.filter((r) => !r.room.completedAt),
    completed = visible.filter((r) => r.room.completedAt).slice(0, 3);
  const action = (record: RoomRecord) => {
    const { room, assignments } = record,
      viewerId = viewerIdFor(room.id),
      me = room.members.find((m) => m.id === viewerId),
      mine = assignments.find((a) => a.id === viewerId),
      active = assignments.find((a) => a.status === "active"),
      done =
        assignments.length > 0 && assignments.every((a) => a.status === "done");
    if (room.members.length < room.size)
      return `팀원 ${room.size - room.members.length}명을 기다리는 중`;
    if (!room.leaderId) return "팀장 결정 대기 중";
    if (!room.roles.length) return "팀장이 역할을 설정하는 중";
    if (!assignments.length)
      return me?.submitted
        ? "희망 순위 제출 완료 · 역할 배정 대기"
        : "희망 순위를 제출해주세요";
    if (!assignments.every((a) => a.accepted))
      return `${mine?.role ?? "배정된"} 역할 수락 대기`;
    if (done) return "최종 제출 확인 대기";
    return mine?.role ? `내 역할 · ${mine.role}` : `${active?.role} 진행 중`;
  };
  return (
    <div className="hero">
      <div className="hero-mark">
        <Sparkles size={26} />
      </div>
      <p className="eyebrow">팀플 역할 배정, 가볍고 공정하게</p>
      <h1>
        “누가 뭐 할래?” 없이
        <br />
        시작하는 팀플.
      </h1>
      <p className="subcopy">팀원을 초대하고 역할을 공정하게 정하세요.</p>
      <div className="hero-actions">
        <button className="button primary" onClick={create}>
          방 만들기
        </button>
        <button className="button secondary" onClick={join}>
          코드로 참가하기
        </button>
      </div>
      <p className="tiny">가입 없이 바로 시작할 수 있어요</p>
      {activeRecords.length > 0 && (
        <div className="project-list">
          <p className="eyebrow">진행 중인 팀플</p>
          {activeRecords.map((r) => (
            <div className="resume-card" key={r.room.id}>
              <h2>{r.room.name}</h2>
              <span className="next-action">{action(r)}</span>
              <button
                className="button primary full"
                onClick={() => open(r.room.id)}
              >
                다시 들어가기
              </button>
            </div>
          ))}
        </div>
      )}
      {completed.length > 0 && (
        <div className="completed-list">
          <p className="eyebrow">완료한 팀플</p>
          {completed.map((r) => (
            <div key={r.room.id}>
              <h2>{r.room.name}</h2>
              <span>완료로 표시 · {formatDate(r.room.completedAt!)}</span>
              <button
                className="button secondary"
                onClick={() => open(r.room.id)}
              >
                결과 보기
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function Create({
  done,
  usedCodes,
}: {
  done: (r: Room) => void;
  usedCodes: Set<string>;
}) {
  const f = new Date(Date.now() + 7 * 86400000);
  f.setMinutes(f.getMinutes() - f.getTimezoneOffset());
  const [name, setName] = useState(""),
    [deadline, setDeadline] = useState(f.toISOString().slice(0, 16)),
    [size, setSize] = useState(4),
    [creator, setCreator] = useState(""),
    [phone, setPhone] = useState(""),
    [kakao, setKakao] = useState(""),
    [email, setEmail] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{ field: string; message: string } | null>(
      null,
    );
  const nr = useRef<HTMLInputElement>(null),
    dr = useRef<HTMLInputElement>(null),
    cr = useRef<HTMLInputElement>(null),
    contactRef = useRef<HTMLInputElement>(null),
    emailRef = useRef<HTMLInputElement>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const fail = (
      field: string,
      message: string,
      target: React.RefObject<HTMLInputElement | null>,
    ) => {
      setError({ field, message });
      requestAnimationFrame(() => {
        target.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        target.current?.focus();
      });
    };
    if (!name.trim()) {
      return fail("name", "팀플 이름을 입력해주세요.", nr);
    }
    if (!deadline || new Date(deadline).getTime() <= Date.now()) {
      return fail("deadline", "최종 제출일은 현재보다 이후여야 합니다.", dr);
    }
    if (!creator.trim()) {
      return fail("creator", "방 개설자 이름을 입력해주세요.", cr);
    }
    if (!phone.trim() && !kakao.trim() && !email.trim()) {
      return fail("contact", "연락수단을 하나 이상 입력해주세요.", contactRef);
    }
    if (phone && !/^[0-9-]+$/.test(phone)) {
      return fail(
        "contact",
        "전화번호는 숫자와 하이픈만 입력할 수 있어요.",
        contactRef,
      );
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail("email", "이메일 형식을 확인해주세요.", emailRef);
    }
    const draft: Room = {
      id: crypto.randomUUID(),
      name: name.trim(),
      deadline: new Date(deadline).toISOString(),
      createdAt: new Date().toISOString(),
      size,
      roles: [],
      code: generateInviteCode(usedCodes),
      members: [
        {
          id: crypto.randomUUID(),
          name: creator.trim(),
          isMe: true,
          isCreator: true,
          contact: {
            phone: phone || undefined,
            kakao: kakao.trim() || undefined,
            email: email || undefined,
          },
        },
      ],
    };
    try {
      setBusy(true);
      done(await createRemoteRoom(draft));
    } catch (cause) {
      setError({
        field: "server",
        message:
          cause instanceof Error ? cause.message : "방을 만들지 못했어요.",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel narrow">
      <Title
        step="새로운 팀플"
        title="방을 만들어볼까요?"
        desc="먼저 빈 방을 만들고 팀원을 초대하세요."
      />
      <form className="form" onSubmit={submit}>
        <Field label="팀플 이름" htmlFor="create-project">
          <input
            id="create-project"
            ref={nr}
            maxLength={40}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error?.field === "name") setError(null);
            }}
            aria-invalid={error?.field === "name"}
            aria-describedby={
              error?.field === "name" ? "create-error" : undefined
            }
            placeholder="예: 소비자 행동 분석"
            autoFocus
          />
          <small className="char-count">{name.length}/40</small>
        </Field>
        <div className="form-row">
          <Field label="최종 제출일과 시간" htmlFor="create-deadline">
            <input
              id="create-deadline"
              ref={dr}
              type="datetime-local"
              value={deadline}
              onChange={(e) => {
                setDeadline(e.target.value);
                if (error?.field === "deadline") setError(null);
              }}
              aria-invalid={error?.field === "deadline"}
              aria-describedby={
                error?.field === "deadline" ? "create-error" : undefined
              }
            />
          </Field>
          <Field label="팀원 수" htmlFor="create-size">
            <select
              id="create-size"
              value={size}
              onChange={(e) => setSize(+e.target.value)}
            >
              {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="방 개설자 이름" htmlFor="create-name">
          <input
            id="create-name"
            ref={cr}
            maxLength={20}
            value={creator}
            onChange={(e) => {
              setCreator(e.target.value);
              if (error?.field === "creator") setError(null);
            }}
            aria-invalid={error?.field === "creator"}
            aria-describedby={
              error?.field === "creator" ? "create-error" : undefined
            }
            placeholder="이름 또는 닉네임"
          />
        </Field>
        <p className="hint">
          방 개설자는 팀장이 아니며, 팀원이 모인 뒤 별도로 결정해요.
        </p>
        <div className="contact-grid">
          <Field label="전화번호" htmlFor="create-phone">
            <input
              id="create-phone"
              ref={contactRef}
              maxLength={20}
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                if (error?.field === "contact") setError(null);
              }}
              aria-invalid={error?.field === "contact"}
              aria-describedby={
                error?.field === "contact" ? "create-error" : undefined
              }
              placeholder="010-0000-0000"
            />
          </Field>
          <Field label="카카오톡 ID" htmlFor="create-kakao">
            <input
              id="create-kakao"
              maxLength={40}
              value={kakao}
              onChange={(e) => {
                setKakao(e.target.value);
                if (error?.field === "contact") setError(null);
              }}
              placeholder="선택 입력"
            />
          </Field>
          <Field label="이메일" htmlFor="create-email">
            <input
              id="create-email"
              ref={emailRef}
              maxLength={100}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error?.field === "contact" || error?.field === "email")
                  setError(null);
              }}
              aria-invalid={error?.field === "email"}
              aria-describedby={
                error?.field === "email" ? "create-error" : undefined
              }
              placeholder="name@example.com"
            />
          </Field>
        </div>
        {error && (
          <p className="error" id="create-error" role="alert">
            {error.message}
          </p>
        )}
        <button className="button primary full" disabled={busy}>
          {busy ? "방을 만드는 중…" : "방 만들기"}
        </button>
      </form>
    </div>
  );
}
function Join({
  done,
  records,
}: {
  done: (r: Room, record?: RoomRecord) => void;
  records: Record<string, RoomRecord>;
}) {
  const [code, setCode] = useState(inviteCode),
    [name, setName] = useState(""),
    [phone, setPhone] = useState(""),
    [kakao, setKakao] = useState(""),
    [email, setEmail] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<{ field: string; message: string } | null>(
      null,
    );
  const codeRef = useRef<HTMLInputElement>(null),
    nameRef = useRef<HTMLInputElement>(null),
    contactRef = useRef<HTMLInputElement>(null),
    emailRef = useRef<HTMLInputElement>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    const fail = (
      field: string,
      message: string,
      target: React.RefObject<HTMLInputElement | null>,
    ) => {
      setError({ field, message });
      requestAnimationFrame(() => {
        target.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        target.current?.focus();
      });
    };
    if (c.length !== 6)
      return fail("code", "6자리 초대 코드를 입력해주세요.", codeRef);
    if (!name.trim()) return fail("name", "이름을 입력해주세요.", nameRef);
    if (!phone.trim() && !kakao.trim() && !email.trim())
      return fail("contact", "연락수단을 하나 이상 입력해주세요.", contactRef);
    if (phone && !/^[0-9-]+$/.test(phone))
      return fail(
        "contact",
        "전화번호는 숫자와 하이픈만 입력할 수 있어요.",
        contactRef,
      );
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return fail("email", "이메일 형식을 확인해주세요.", emailRef);
    const stored = Object.values(records).find(
      (record) => record.room.code === c,
    );
    const target = stored?.room ?? (DEV && c === "CARRY1" ? MOCK_ROOM : null);
    if (DEV && target?.id === MOCK_ROOM.id) {
      if (target.members.some((m) => m.name === name.trim()))
        return fail("name", "이미 사용 중인 이름이에요.", nameRef);
      return done({
        ...target,
        members: [
          ...target.members.map((member) => ({ ...member, isMe: false })),
          {
            id: crypto.randomUUID(),
            name: name.trim(),
            isMe: true,
            contact: {
              phone: phone || undefined,
              kakao: kakao.trim() || undefined,
              email: email || undefined,
            },
          },
        ],
      });
    }
    try {
      setBusy(true);
      const joined = await joinRemoteRoom({
        code: c,
        name: name.trim(),
        phone: phone.trim() || undefined,
        kakao: kakao.trim() || undefined,
        email: email.trim() || undefined,
      });
      rememberViewer(joined.record.room.id, joined.memberId);
      const migrated = migrateRecord(joined.record);
      if (!migrated) throw new Error("방 데이터를 불러오지 못했어요.");
      const hydrated = hydrateViewer(migrated);
      done(hydrated.room, hydrated);
    } catch (cause) {
      fail(
        "code",
        cause instanceof Error ? cause.message : "방에 들어가지 못했어요.",
        codeRef,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel narrow">
      <Title
        step="팀원으로 참가"
        title="초대받은 방에 들어가세요"
        desc="연락수단은 같은 방의 팀원만 확인할 수 있어요."
      />
      <form className="form" onSubmit={submit}>
        <Field label="초대 코드" htmlFor="join-code">
          <input
            id="join-code"
            ref={codeRef}
            className="code-input"
            maxLength={6}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
              if (error?.field === "code") setError(null);
            }}
            aria-invalid={error?.field === "code"}
            aria-describedby={
              error?.field === "code" ? "join-error" : undefined
            }
            placeholder="6자리 코드"
          />
        </Field>
        {DEV && (
          <p className="hint">
            테스트 코드{" "}
            <button type="button" onClick={() => setCode("CARRY1")}>
              CARRY1
            </button>
          </p>
        )}
        <Field label="이름" htmlFor="join-name">
          <input
            id="join-name"
            ref={nameRef}
            maxLength={20}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error?.field === "name") setError(null);
            }}
            aria-invalid={error?.field === "name"}
            aria-describedby={
              error?.field === "name" ? "join-error" : undefined
            }
            placeholder="팀원에게 보일 이름"
          />
        </Field>
        <div className="contact-grid">
          <Field label="전화번호" htmlFor="join-phone">
            <input
              id="join-phone"
              ref={contactRef}
              maxLength={20}
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                if (error?.field === "contact") setError(null);
              }}
              aria-invalid={error?.field === "contact"}
              aria-describedby={
                error?.field === "contact" ? "join-error" : undefined
              }
              placeholder="010-0000-0000"
            />
          </Field>
          <Field label="카카오톡 ID" htmlFor="join-kakao">
            <input
              id="join-kakao"
              maxLength={40}
              value={kakao}
              onChange={(e) => {
                setKakao(e.target.value);
                if (error?.field === "contact") setError(null);
              }}
              placeholder="선택 입력"
            />
          </Field>
          <Field label="이메일" htmlFor="join-email">
            <input
              id="join-email"
              ref={emailRef}
              maxLength={100}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error?.field === "contact" || error?.field === "email")
                  setError(null);
              }}
              aria-invalid={error?.field === "email"}
              aria-describedby={
                error?.field === "email" ? "join-error" : undefined
              }
              placeholder="name@example.com"
            />
          </Field>
        </div>
        {DEV && (
          <p className="hint">
            이제 다른 기기에서도 같은 코드로 참가할 수 있어요.
          </p>
        )}
        {error && (
          <p className="error" id="join-error" role="alert">
            {error.message}
          </p>
        )}
        <button className="button primary full" disabled={busy}>
          {busy ? "방을 찾는 중…" : "입장하기"}
        </button>
      </form>
    </div>
  );
}
function Lobby({
  room,
  setRoom,
  assign,
  editing,
  setEditing,
  roleEdit,
  copy,
  leave,
}: {
  room: Room;
  setRoom: (r: Room) => Promise<boolean>;
  assign: () => void;
  editing: boolean;
  setEditing: (v: boolean) => void;
  roleEdit: () => void;
  copy: (s: string) => void;
  leave: () => void;
}) {
  const me = room.members.find((m) => m.isMe),
    full = room.members.length === room.size,
    all = full && room.members.every((m) => m.submitted);
  const [order, setOrder] = useState<string[]>(
      me?.preferences ?? room.roles.map((role) => role.id),
    ),
    [open, setOpen] = useState<string | null>(null),
    [drag, setDrag] = useState<number | null>(null),
    [kick, setKick] = useState<Member | null>(null),
    [leaveOpen, setLeaveOpen] = useState(false);
  const memberButtons = useRef(new Map<string, HTMLButtonElement>()),
    membersRef = useRef<HTMLDivElement>(null);
  useEffect(
    () => setOrder(me?.preferences ?? room.roles.map((role) => role.id)),
    [room.roles.map((role) => role.id).join("|"), me?.preferences?.join("|")],
  );
  useEffect(() => {
    if (open === null) return;
    const close = () => {
      const opener = memberButtons.current.get(open);
      setOpen(null);
      requestAnimationFrame(() => opener?.focus());
    };
    const pointer = (event: PointerEvent) => {
      if (!membersRef.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const a = [...order];
    [a[i], a[j]] = [a[j], a[i]];
    setOrder(a);
    if (me?.submitted)
      setRoom({
        ...room,
        members: room.members.map((m) =>
          m.isMe ? { ...m, submitted: false } : m,
        ),
      });
  };
  const add = () => {
    if (full) return;
    const used = room.members.map((m) => m.name),
      name =
        demoNames.find((n) => !used.includes(n)) ??
        `팀원 ${room.members.length + 1}`;
    setRoom({
      ...room,
      members: [
        ...room.members,
        { id: crypto.randomUUID(), name, contact: { kakao: `${name}_carry` } },
      ],
    });
  };
  return (
    <div className="panel">
      <Title
        step="대기실"
        title={room.name}
        desc={`최종 제출 · ${formatDate(room.deadline)}`}
      />
      <div className="invite-box">
        <div>
          <span>초대 코드</span>
          <strong>{room.code}</strong>
        </div>
        <button className="copy-button" onClick={() => copy(room.code)}>
          <Clipboard size={17} />
          복사
        </button>
      </div>
      <div className="section-head">
        <div>
          <h2>팀원</h2>
          <p>
            {full
              ? room.leaderId
                ? "팀장이 다음 단계를 준비하고 있어요."
                : "모두 모였어요. 팀장을 정해주세요."
              : `${room.size - room.members.length}명을 기다리고 있어요.`}
          </p>
        </div>
        <strong>
          {room.members.length}
          <span> / {room.size}명</span>
        </strong>
      </div>
      <div className="members" ref={membersRef}>
        {Array.from({ length: room.size }, (_, i) => {
          const m = room.members[i];
          return m ? (
            <div className="member-wrap" key={m.id}>
              <button
                className="member"
                ref={(node) => {
                  if (node) memberButtons.current.set(m.id, node);
                  else memberButtons.current.delete(m.id);
                }}
                onClick={() => setOpen(open === m.id ? null : m.id)}
                aria-haspopup="true"
                aria-expanded={open === m.id}
                aria-controls={`contact-${m.id}`}
              >
                <div className="avatar">{m.name[0]}</div>
                <span>{m.name}</span>
                {m.isMe && <em>나</em>}
                {m.isCreator && <em>방 개설자</em>}
                {m.isHost && <em>팀장</em>}
                <small className={`submission ${m.submitted ? "done" : ""}`}>
                  {m.submitted ? "제출 완료" : m.isMe ? "작성 중" : "대기 중"}
                </small>
                <ChevronDown size={18} />
              </button>
              {open === m.id && (
                <div className="contact-details" id={`contact-${m.id}`}>
                  {Object.entries(m.contact)
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k}>
                        {k === "email" ? <Mail /> : <Users />}
                        <span>{v}</span>
                        <button
                          onClick={() => copy(v!)}
                          aria-label={
                            k === "email"
                              ? "이메일 주소 복사"
                              : k === "phone"
                                ? "전화번호 복사"
                                : "카카오톡 ID 복사"
                          }
                        >
                          <Clipboard size={14} />
                        </button>
                      </div>
                    ))}
                  {me?.isCreator && !room.leaderId && !m.isCreator && (
                    <button className="kick-button" onClick={() => setKick(m)}>
                      방에서 내보내기
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="member empty" key={i}>
              <div className="avatar">
                <Users size={18} />
              </div>
              <span>아직 비어 있어요</span>
            </div>
          );
        })}
      </div>
      {!full && DEV && (
        <div className="demo-action">
          <button className="button ghost" onClick={add}>
            <UserPlus size={18} />
            가상 팀원 추가
          </button>
          <small>프로토타입 테스트용</small>
        </div>
      )}
      {!room.leaderId && (
        <button className="leave-button" onClick={() => setLeaveOpen(true)}>
          방 나가기
        </button>
      )}
      {full && !room.leaderId && (
        <LeaderDecision room={room} setRoom={setRoom} />
      )}
      {full && room.leaderId && (room.roles.length === 0 || editing) && (
        <RoleSetup
          room={room}
          setRoom={setRoom}
          editing={editing}
          onDone={() => setEditing(false)}
        />
      )}
      {full && room.leaderId && room.roles.length > 0 && !editing && (
        <>
          <div className="preference-head">
            <div>
              <h2>내 역할 희망 순위</h2>
              <p>왼쪽 손잡이를 끌어 희망 순서를 정하세요.</p>
            </div>
            {me?.isHost && (
              <button className="mini-button" onClick={roleEdit}>
                <Pencil size={15} />
                역할 수정
              </button>
            )}
          </div>
          <SortableList
            items={order}
            onChange={setOrder}
            label={(id, i) =>
              `${room.roles.find((r) => r.id === id)?.name} ${i + 1}지망. 드래그 또는 위아래 방향키로 이동`
            }
            render={(id, i) => (
              <>
                <strong>{i + 1}지망</strong>
                <span>{room.roles.find((r) => r.id === id)?.name}</span>
                <small>
                  {room.roles.find((r) => r.id === id)?.deliverable}
                  <br />
                  개인 마감 ·{" "}
                  {formatDate(room.roles.find((r) => r.id === id)!.deadline)}
                </small>
              </>
            )}
          />
          <button
            className={`button ${me?.submitted ? "secondary" : "primary"} full`}
            onClick={() =>
              setRoom({
                ...room,
                members: room.members.map((m) =>
                  m.isMe ? { ...m, preferences: order, submitted: true } : m,
                ),
              })
            }
          >
            {me?.submitted ? "순위 다시 제출" : "내 희망 순위 제출"}
          </button>
          {DEV && (
            <div className="demo-action">
              <button
                className="text-button"
                onClick={() =>
                  setRoom({
                    ...room,
                    members: room.members.map((m) =>
                      m.isMe
                        ? m
                        : {
                            ...m,
                            preferences: shuffled(
                              room.roles.map((role) => role.id),
                            ),
                            submitted: true,
                          },
                    ),
                  })
                }
              >
                <Sparkles size={16} />
                가상 팀원 순위 자동 생성
              </button>
              <small>개발·데모용</small>
            </div>
          )}
          {me?.isHost ? (
            <button
              className="button primary full"
              disabled={!all}
              onClick={assign}
            >
              {all
                ? "가장 공정하게 역할 배정"
                : `${room.members.filter((m) => !m.submitted).length}명의 제출을 기다리는 중`}
            </button>
          ) : (
            <p className="host-note">
              모두 제출하면 팀장이 역할을 배정할 수 있어요.
            </p>
          )}
        </>
      )}
      {kick && (
        <Confirm
          title={`‘${kick.name}’ 팀원을 방에서 내보낼까요?`}
          body="참가 정보와 현재 입력 상태가 이 방에서 제거됩니다. 다시 참가하려면 초대 코드가 필요합니다."
          action="내보내기"
          cancel={() => setKick(null)}
          proceed={() => {
            setRoom({
              ...room,
              members: room.members.filter((m) => m.id !== kick.id),
            });
            setKick(null);
          }}
        />
      )}
      {leaveOpen && (
        <Confirm
          title={me?.isCreator ? "방을 나갈까요?" : "이 방에서 나갈까요?"}
          body={
            me?.isCreator
              ? "아직 팀장이 정해지지 않았습니다. 방 개설자가 나가면 남은 팀원 중 가장 먼저 참가한 사람이 임시 개설자가 됩니다."
              : "다시 참가하려면 초대 코드가 필요합니다."
          }
          action="방 나가기"
          cancel={() => setLeaveOpen(false)}
          proceed={leave}
        />
      )}
    </div>
  );
}
function LeaderDecision({
  room,
  setRoom,
}: {
  room: Room;
  setRoom: (r: Room) => Promise<boolean>;
}) {
  const mode = room.decision?.mode ?? null;
  const candidate = room.decision?.candidate ?? null;
  const consents = room.decision?.consents ?? [];
  const me = room.members.find((m) => m.isMe);
  const setMode = (mode: "known" | "random" | null) =>
    setRoom({ ...room, decision: mode ? { mode, consents: [] } : undefined });
  const setCandidate = (candidate: string | null) =>
    setRoom({
      ...room,
      decision: {
        ...room.decision,
        candidate: candidate ?? undefined,
        consents: [],
      },
    });
  const setConsents = (consents: string[]) =>
    setRoom({ ...room, decision: { ...room.decision, consents } });
  const [notice, setNotice] = useState(""),
    [changeMode, setChangeMode] = useState(false),
    [cancelCandidate, setCancelCandidate] = useState(false);
  const appoint = (id: string) =>
    setRoom({
      ...room,
      leaderId: id,
      members: room.members.map((m) => ({ ...m, isHost: m.id === id })),
    });
  return (
    <section className="decision-box">
      <p className="eyebrow">팀장 결정</p>
      <h2>팀장은 어떻게 정할까요?</h2>
      {!mode && !me?.isCreator && (
        <p>방 개설자가 팀장 결정 방식을 선택하고 있어요.</p>
      )}
      {!mode && me?.isCreator && (
        <div className="choice-grid">
          <button className="button secondary" onClick={() => setMode("known")}>
            이미 정해졌어요
          </button>
          <button className="button primary" onClick={() => setMode("random")}>
            랜덤으로 정하기
          </button>
        </div>
      )}
      {mode === "known" && (
        <>
          {!candidate ? (
            <>
              <p>방 개설자가 팀장 후보를 선택해주세요.</p>
              <div className="candidate-grid">
                {room.members.map((m) => (
                  <button
                    key={m.id}
                    disabled={!me?.isCreator}
                    onClick={() => setCandidate(m.id)}
                  >
                    {m.name}
                    {m.isCreator && <small>방 개설자</small>}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="nomination">
              <strong>{`‘${room.members.find((m) => m.id === candidate)?.name}’ 팀원이 팀장으로 지목됐어요.`}</strong>
              <p>이 팀장을 수락하시겠습니까? 모두 동의하면 확정됩니다.</p>
              <div className="consent-list">
                {room.members.map((m) => (
                  <span key={m.id}>
                    {m.name}
                    <em>{consents.includes(m.id) ? "동의" : "대기 중"}</em>
                  </span>
                ))}
              </div>
              {notice && <p className="error">{notice}</p>}
              {me && !consents.includes(me.id) && (
                <div>
                  <button
                    className="button secondary"
                    onClick={() => {
                      setCandidate(null);
                      setNotice("");
                    }}
                  >
                    거절
                  </button>
                  <button
                    className="button primary"
                    onClick={() => {
                      const next = [...consents, me.id];
                      if (next.length === room.members.length)
                        setRoom({
                          ...room,
                          decision: { ...room.decision, consents: next },
                          leaderId: candidate,
                          members: room.members.map((m) => ({
                            ...m,
                            isHost: m.id === candidate,
                          })),
                        });
                      else setConsents(next);
                    }}
                  >
                    수락
                  </button>
                </div>
              )}
              {me && consents.includes(me.id) && (
                <p>동의했어요. 다른 팀원의 응답을 기다리고 있어요.</p>
              )}
              {DEV && !room.members.find((m) => m.id === candidate)?.isMe && (
                <small>
                  가상 팀원의 응답을 대신 처리하는 개발·데모용 컨트롤
                </small>
              )}
              {room.members.find((m) => m.isCreator)?.isMe && (
                <button
                  className="leave-button"
                  onClick={() => setCancelCandidate(true)}
                >
                  후보 선택 취소
                </button>
              )}
            </div>
          )}
        </>
      )}
      {mode === "random" && (
        <div className="nomination">
          <strong>팀장을 무작위로 정하는 데 동의하나요?</strong>
          <div className="consent-list">
            {room.members.map((m) => (
              <span key={m.id}>
                {m.name}
                <em>{consents.includes(m.id) ? "동의" : "대기 중"}</em>
              </span>
            ))}
          </div>
          {!consents.includes(room.members.find((m) => m.isMe)?.id ?? "") && (
            <button
              className="button primary full"
              onClick={() =>
                setConsents([...consents, room.members.find((m) => m.isMe)!.id])
              }
            >
              동의
            </button>
          )}
          {DEV && (
            <button
              className="button secondary full"
              onClick={() => setConsents(room.members.map((m) => m.id))}
            >
              가상 팀원 전원 동의
            </button>
          )}
          {DEV && <small>개발·데모용</small>}
          <p>모두 동의하면 자동으로 팀장이 정해져요.</p>
          {me?.isCreator && (
            <button
              className="leave-button"
              onClick={() => setChangeMode(true)}
            >
              팀장 결정 방식 변경
            </button>
          )}
        </div>
      )}
      {changeMode && (
        <Confirm
          title="팀장 결정 방식을 변경할까요?"
          body="현재까지 받은 랜덤 추첨 동의가 초기화됩니다."
          action="방식 변경"
          cancel={() => setChangeMode(false)}
          proceed={() => {
            setMode(null);
            setChangeMode(false);
          }}
        />
      )}
      {cancelCandidate && (
        <Confirm
          title="팀장 후보 선택을 취소할까요?"
          body="현재 후보 요청만 초기화되고 다른 팀원을 선택할 수 있어요."
          action="선택 취소"
          cancel={() => setCancelCandidate(false)}
          proceed={() => {
            setCandidate(null);
            setCancelCandidate(false);
          }}
        />
      )}
    </section>
  );
}
function RoleSetup({
  room,
  setRoom,
  editing,
  onDone,
}: {
  room: Room;
  setRoom: (r: Room) => Promise<boolean>;
  editing: boolean;
  onDone: () => void;
}) {
  const defaults = DEFAULT_ROLES.slice(0, room.size).concat(
      Array.from(
        { length: Math.max(0, room.size - 4) },
        (_, i) => `역할 ${i + 5}`,
      ),
    ),
    dates = createRoleDeadlines(room.deadline, room.size);
  const [items, setItems] = useState<Role[]>(
      room.roles.length
        ? room.roles.map((role) => ({
            ...role,
            deadline: toLocalDateTimeInput(role.deadline),
          }))
        : defaults.map((name, i) => ({
            id: crypto.randomUUID(),
            name,
            deliverable: "",
            deadline: toLocalDateTimeInput(dates[i]),
          })),
    ),
    [error, setError] = useState<{
      index: number;
      field: "name" | "deliverable" | "deadline";
      message: string;
    } | null>(null),
    [drag, setDrag] = useState<number | null>(null);
  const me = room.members.find((m) => m.isMe),
    leader = room.members.find((m) => m.id === room.leaderId);
  if (!me?.isHost)
    return (
      <section className="decision-box">
        <p className="eyebrow">팀장 확정</p>
        <h2>{leader?.name}님이 역할을 설정하고 있어요</h2>
        <p>설정이 끝나면 희망 순위를 제출할 수 있어요.</p>
        {DEV && (
          <button
            className="button secondary"
            onClick={() =>
              setRoom({
                ...room,
                members: room.members.map((m) => ({
                  ...m,
                  isMe: m.id === room.leaderId,
                })),
              })
            }
          >
            팀장 화면으로 전환
          </button>
        )}
        {DEV && <small>개발·데모용</small>}
      </section>
    );
  const save = async () => {
    const fail = (
      index: number,
      field: "name" | "deliverable" | "deadline",
      message: string,
    ) => {
      setError({ index, field, message });
      requestAnimationFrame(() => {
        const target = document.querySelector<HTMLInputElement>(
          `[data-role-field="${index}-${field}"]`,
        );
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
        target?.focus();
      });
    };
    const missingName = items.findIndex((x) => !x.name.trim());
    if (missingName >= 0)
      return fail(missingName, "name", "역할 이름을 입력해주세요.");
    const normalizedNames = items.map((x) => x.name.trim());
    const duplicateName = normalizedNames.findIndex(
      (name, index) => normalizedNames.indexOf(name) !== index,
    );
    if (duplicateName >= 0)
      return fail(
        duplicateName,
        "name",
        "같은 역할 이름을 두 번 사용할 수 없어요.",
      );
    const missingResult = items.findIndex((x) => !x.deliverable.trim());
    if (missingResult >= 0)
      return fail(
        missingResult,
        "deliverable",
        "완료할 결과물을 입력해주세요.",
      );
    const times = items.map((x) => new Date(x.deadline).getTime()),
      end = new Date(room.deadline).getTime();
    const bad = times.findIndex((t) => !t || t <= Date.now() || t >= end);
    if (bad >= 0)
      return fail(
        bad,
        "deadline",
        "개인 마감은 현재 이후, 최종 제출 이전이어야 합니다.",
      );
    const order = times.findIndex((t, i) => i > 0 && times[i - 1] >= t);
    if (order >= 0)
      return fail(
        order,
        "deadline",
        "앞 단계의 마감은 뒤 단계보다 빨라야 합니다.",
      );
    const roles = items.map((x) => ({
      ...x,
      name: x.name.trim(),
      deliverable: x.deliverable.trim(),
      deadline: new Date(x.deadline).toISOString(),
    }));
    const original = room.roles.map((role) => ({
      ...role,
      name: role.name.trim(),
      deliverable: role.deliverable.trim(),
      deadline: new Date(role.deadline).toISOString(),
    }));
    const changed = JSON.stringify(roles) !== JSON.stringify(original);
    const saved = await setRoom({
      ...room,
      roles,
      members: changed
        ? room.members.map((member) => ({
            ...member,
            submitted: false,
            preferences: undefined,
          }))
        : room.members,
    });
    if (saved) onDone();
  };
  return (
    <section className="role-setup">
      <div className="preference-head">
        <div>
          <p className="eyebrow">팀장 설정</p>
          <h2>역할과 결과물을 정해주세요</h2>
          <p>카드 순서가 실제 작업 진행 순서가 돼요.</p>
        </div>
      </div>
      {items.map((x, i) => (
        <div
          className="setup-card"
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (drag === null) return;
            const a = [...items],
              v = a.splice(drag, 1)[0];
            a.splice(i, 0, v);
            setItems(a);
          }}
          key={x.id}
        >
          <GripVertical />
          <strong>{i + 1}단계</strong>
          <Field label="역할 이름" htmlFor={`role-${x.id}-name`}>
            <input
              id={`role-${x.id}-name`}
              maxLength={30}
              data-role-field={`${i}-name`}
              aria-invalid={error?.index === i && error.field === "name"}
              aria-describedby={
                error?.index === i && error.field === "name"
                  ? `role-error-${i}-name`
                  : undefined
              }
              value={x.name}
              onChange={(e) => {
                setError(null);
                setItems(
                  items.map((v, j) =>
                    j === i ? { ...v, name: e.target.value } : v,
                  ),
                );
              }}
            />
            {error?.index === i && error.field === "name" && (
              <small className="field-error" id={`role-error-${i}-name`}>
                {error.message}
              </small>
            )}
          </Field>
          <Field label="완료할 결과물" htmlFor={`role-${x.id}-deliverable`}>
            <input
              id={`role-${x.id}-deliverable`}
              maxLength={120}
              data-role-field={`${i}-deliverable`}
              aria-invalid={error?.index === i && error.field === "deliverable"}
              aria-describedby={
                error?.index === i && error.field === "deliverable"
                  ? `role-error-${i}-deliverable`
                  : undefined
              }
              value={x.deliverable}
              onChange={(e) => {
                setError(null);
                setItems(
                  items.map((v, j) =>
                    j === i ? { ...v, deliverable: e.target.value } : v,
                  ),
                );
              }}
              placeholder="완료 기준을 구체적으로 적어주세요"
            />
            <small className="char-count">{x.deliverable.length}/120</small>
            {error?.index === i && error.field === "deliverable" && (
              <small className="field-error" id={`role-error-${i}-deliverable`}>
                {error.message}
              </small>
            )}
          </Field>
          <Field label="개인 마감" htmlFor={`role-${x.id}-deadline`}>
            <input
              id={`role-${x.id}-deadline`}
              type="datetime-local"
              data-role-field={`${i}-deadline`}
              aria-invalid={error?.index === i && error.field === "deadline"}
              aria-describedby={
                error?.index === i && error.field === "deadline"
                  ? `role-error-${i}-deadline`
                  : undefined
              }
              value={x.deadline}
              onChange={(e) => {
                setError(null);
                setItems(
                  items.map((v, j) =>
                    j === i ? { ...v, deadline: e.target.value } : v,
                  ),
                );
              }}
            />
            {error?.index === i && error.field === "deadline" && (
              <small className="field-error" id={`role-error-${i}-deadline`}>
                {error.message}
              </small>
            )}
          </Field>
        </div>
      ))}
      <div className="role-setup-actions">
        {editing && (
          <button className="button secondary" onClick={onDone}>
            취소
          </button>
        )}
        <button className="button primary" onClick={save}>
          {editing ? "변경 사항 저장" : "역할 설정 완료"}
        </button>
      </div>
    </section>
  );
}
function Assigning() {
  return (
    <div className="assigning">
      <div className="shuffle-icon">
        <RefreshCw size={28} />
      </div>
      <h1>
        가장 공정한 조합을
        <br />
        찾고 있어요
      </h1>
      <p>모두의 희망 순위를 함께 계산하고 있어요</p>
      <div className="progress">
        <span />
      </div>
    </div>
  );
}
function Results({
  room,
  result,
  assignments,
  accept,
  retry,
  acceptDemo,
  start,
}: {
  room: Room;
  result: FairAssignmentResult;
  assignments: Assignment[];
  accept: () => void;
  retry: () => void;
  acceptDemo: () => void;
  start: () => void;
}) {
  const first = assignments.filter((a) => a.rank === 1).length;
  const someAccepted = assignments.some((a) => a.accepted),
    allAccepted = assignments.every((a) => a.accepted);
  return (
    <div className="panel">
      <Title
        step="역할 배정 완료"
        title="가장 공정한 조합을 찾았어요"
        desc={`전원이 ${result.worstRank}지망 이내에 배정됐어요.`}
      />
      <div className="result-summary">
        <CheckCircle2 />
        <div>
          <strong>
            {room.size}명 중 {first}명이 1지망 역할을 받았어요.
          </strong>
          {result.optimalCombinationCount > 1 && (
            <span>
              동일한 최적 조합 {result.optimalCombinationCount}개 중 무작위로
              결정했어요.
            </span>
          )}
        </div>
      </div>
      <div className="assignment-grid">
        {assignments.map((a) => (
          <article className={`assignment ${a.isMe ? "mine" : ""}`} key={a.id}>
            {a.isMe && <div className="mine-badge">내 역할</div>}
            <div className="avatar">{a.name[0]}</div>
            <div className="assignment-copy">
              <p>{a.name}</p>
              <h3>
                {a.role} <em>· {a.rank}지망</em>
              </h3>
              <div>
                <Clock3 size={15} />
                {formatDate(a.deadline)}까지
              </div>
            </div>
            <strong>{a.accepted ? "수락 완료" : "수락 대기"}</strong>
          </article>
        ))}
      </div>
      <div className="result-actions">
        {!assignments.find((a) => a.isMe)?.accepted && (
          <button className="button primary" onClick={accept}>
            <Check size={18} />내 역할 수락
          </button>
        )}
        {DEV && (
          <button className="button secondary" onClick={acceptDemo}>
            가상 팀원 수락 처리
          </button>
        )}
        {allAccepted &&
          room.members.find((m) => m.isMe)?.isHost &&
          !room.startedAt && (
            <button className="button primary" onClick={start}>
              팀 진행 시작
            </button>
          )}
        {room.members.find((m) => m.isMe)?.isHost && !allAccepted && (
          <button
            className="button secondary"
            disabled={someAccepted}
            onClick={retry}
            title={
              someAccepted
                ? "역할 수락이 시작되어 다시 배정할 수 없어요."
                : undefined
            }
          >
            <RefreshCw size={17} />
            다시 배정
          </button>
        )}
      </div>
      {allAccepted && !room.members.find((m) => m.isMe)?.isHost && (
        <p className="host-note">
          모두 수락했어요. 팀장이 진행을 시작하면 자동으로 넘어가요.
        </p>
      )}
      {someAccepted &&
        !allAccepted &&
        room.members.find((m) => m.isMe)?.isHost && (
          <p className="host-note">
            역할 수락이 시작되어 다시 배정할 수 없어요.
          </p>
        )}
    </div>
  );
}
function Progress({
  room,
  assignments,
  setAssignments,
  home,
  finish,
}: {
  room: Room;
  assignments: Assignment[];
  setAssignments: React.Dispatch<React.SetStateAction<Assignment[]>>;
  home: () => void;
  finish: (completedAt: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState<{
    type: "complete" | "remind" | "submit";
    id: string;
  } | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const done = assignments.filter((a) => a.status === "done").length,
    pct = Math.round((done / assignments.length) * 100),
    start = new Date(room.createdAt ?? Date.now()).getTime(),
    elapsed = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          ((now - start) / (new Date(room.deadline).getTime() - start)) * 100,
        ),
      ),
    );
  const complete = (id: string) =>
    setAssignments((list) => {
      const ordered = [...list].sort(
          (a, b) =>
            room.roles.findIndex((role) => role.id === a.roleId) -
            room.roles.findIndex((role) => role.id === b.roleId),
        ),
        idx = ordered.findIndex((a) => a.id === id);
      return list.map((a) =>
        a.id === id
          ? { ...a, status: "done", completedAt: new Date().toISOString() }
          : idx + 1 < ordered.length && a.id === ordered[idx + 1].id
            ? { ...a, status: "active" }
            : a,
      );
    });
  const active = assignments.find((a) => a.status === "active"),
    me = assignments.find((a) => a.isMe),
    allDone =
      assignments.length > 0 && assignments.every((a) => a.status === "done"),
    gap = pct - elapsed,
    comparison =
      gap >= 10
        ? "계획보다 빠르게 진행 중이에요."
        : gap <= -10
          ? "일정보다 진행이 늦어요."
          : "일정에 맞춰 진행 중이에요.";
  return (
    <div className="panel progress-panel">
      <Title
        step="팀 진행"
        title={allDone ? "모든 역할이 완료됐어요." : room.name}
        desc={
          allDone
            ? "이제 최종 결과물을 확인하고 제출해주세요."
            : `최종 제출까지 ${countdown(room.deadline, now)} 남았어요.`
        }
      />
      <div className="metrics">
        <Gauge label="역할 진행률" value={pct} />
        <Gauge label="시간 경과" value={elapsed} muted />
      </div>
      <p className="pace-copy">{comparison}</p>
      {DEV && (
        <div className="demo-switch">
          <span>현재 사용자 테스트</span>
          <select
            aria-label="현재 사용자 테스트"
            value={me?.id}
            onChange={(e) =>
              setAssignments((list) =>
                list.map((a) => ({ ...a, isMe: a.id === e.target.value })),
              )
            }
          >
            {assignments.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <small>개발·데모용</small>
        </div>
      )}
      {active?.remindedAt && active.isMe && (
        <div className="reminder-notice">
          {`팀원이 ‘${active.role}’ 진행 상황을 기다리고 있어요.`}
          <span>{formatDate(active.remindedAt)} 요청됨</span>
        </div>
      )}
      <div className="timeline">
        {assignments.map((a, i) => (
          <div className={`timeline-step ${a.status}`} key={a.id}>
            <div className="timeline-line">
              <span>{a.status === "done" ? <Check /> : i + 1}</span>
            </div>
            <div className="timeline-card">
              <div>
                <em>
                  {a.status === "done"
                    ? "완료"
                    : a.status === "active"
                      ? "진행 중"
                      : "대기"}
                </em>
                <h3>{a.role}</h3>
                <p>
                  {room.roles.find((role) => role.id === a.roleId)?.deliverable}
                </p>
                {a.status === "done" ? (
                  <p>
                    {a.name}
                    <br />
                    {formatDate(a.completedAt!)} 완료
                  </p>
                ) : (
                  <p>
                    {a.name}
                    <br />
                    마감 · {formatDate(a.deadline)}
                    <br />
                    마감까지 {countdown(a.deadline, now)}
                  </p>
                )}
              </div>
              {a.status === "active" && a.isMe && (
                <button
                  className="mini-button"
                  onClick={() => setPending({ type: "complete", id: a.id })}
                >
                  단계 완료
                </button>
              )}
              {a.status === "active" && !a.isMe && (
                <button
                  className="mini-button"
                  disabled={
                    !!a.remindedAt &&
                    now - new Date(a.remindedAt).getTime() < 86400000
                  }
                  onClick={() => setPending({ type: "remind", id: a.id })}
                >
                  {a.remindedAt
                    ? "24시간 후 다시 보내기"
                    : `${a.name}에게 리마인드`}
                </button>
              )}
            </div>
          </div>
        ))}
        <div className="timeline-step final">
          <div className="timeline-line">
            <span>
              <Clock3 />
            </span>
          </div>
          <div className="timeline-card">
            <div>
              <em>{room.completedAt ? "완료" : "최종 마감"}</em>
              <h3>최종 제출</h3>
              <p>{formatDate(room.deadline)}</p>
            </div>
            {allDone && me?.isHost && !room.completedAt && (
              <button
                className="mini-button"
                onClick={() => setPending({ type: "submit", id: me.id })}
              >
                제출 완료로 표시
              </button>
            )}
          </div>
        </div>
      </div>
      <button className="button secondary full" onClick={home}>
        시작 화면으로
      </button>
      {pending?.type === "complete" && (
        <Confirm
          title={`‘${assignments.find((a) => a.id === pending.id)?.role}’ 단계를 완료할까요?`}
          body={
            assignments.findIndex((a) => a.id === pending.id) ===
            assignments.length - 1
              ? "완료하면 모든 역할이 완료됩니다."
              : `완료하면 ‘${assignments[assignments.findIndex((a) => a.id === pending.id) + 1]?.role}’ 단계가 시작됩니다.`
          }
          action="완료"
          cancel={() => setPending(null)}
          proceed={() => {
            complete(pending.id);
            setPending(null);
          }}
        />
      )}
      {pending?.type === "remind" && (
        <Confirm
          title={`‘${assignments.find((a) => a.id === pending.id)?.name}’ 팀원에게 진행 상황 확인을 요청할까요?`}
          body={`${assignments.find((a) => a.id === pending.id)?.role} 마감까지 ${countdown(assignments.find((a) => a.id === pending.id)!.deadline, now)} 남았습니다.`}
          action="보내기"
          cancel={() => setPending(null)}
          proceed={() => {
            setAssignments((list) =>
              list.map((a) =>
                a.id === pending.id
                  ? { ...a, remindedAt: new Date().toISOString() }
                  : a,
              ),
            );
            setPending(null);
          }}
        />
      )}
      {pending?.type === "submit" && (
        <Confirm
          title="학교 제출을 완료했나요?"
          body={
            "Carry는 학교 시스템에 파일을 제출하지 않습니다.\n이미 외부에서 제출했다면 완료 상태로 표시해주세요."
          }
          action="제출 완료로 표시"
          cancel={() => setPending(null)}
          proceed={() => {
            finish(new Date().toISOString());
            setPending(null);
          }}
        />
      )}
    </div>
  );
}
function Completed({
  room,
  home,
  hide,
}: {
  room: Room;
  home: () => void;
  hide: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="complete-screen">
      <div className="complete-mark">
        <Check size={30} />
      </div>
      <p className="eyebrow">팀플 완료</p>
      <h1>{`‘${room.name}’을 완료했어요.`}</h1>
      <p>외부 제출 완료 상태로 기록했습니다.</p>
      <div className="submitted-at">
        <span>완료로 표시한 시각</span>
        <strong>{formatDate(room.completedAt!)}</strong>
      </div>
      <div className="complete-actions">
        <button className="button primary" onClick={home}>
          시작 화면으로
        </button>
        <button className="button secondary" onClick={() => setConfirm(true)}>
          목록에서 숨기기
        </button>
      </div>
      {confirm && (
        <Confirm
          title="이 팀플을 목록에서 숨길까요?"
          body="이 기기의 Carry 목록에서만 사라집니다."
          action="숨기기"
          cancel={() => setConfirm(false)}
          proceed={() => {
            hide();
            setConfirm(false);
            home();
          }}
        />
      )}
    </div>
  );
}
function Gauge({
  label,
  value,
  muted,
}: {
  label: string;
  value: number;
  muted?: boolean;
}) {
  return (
    <div className="gauge">
      <div>
        <span>{label}</span>
        <strong>{value}%</strong>
      </div>
      <div className={muted ? "muted" : ""}>
        <span style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
function Confirm({
  title,
  body,
  action,
  cancel,
  proceed,
}: {
  title: string;
  body: string;
  action: string;
  cancel: () => void;
  proceed: () => void;
}) {
  const titleId = useId(),
    bodyId = useId(),
    cancelRef = useRef<HTMLButtonElement>(null),
    opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
      if (e.key === "Tab") {
        const root = cancelRef.current?.closest('[role="dialog"]'),
          buttons = root?.querySelectorAll<HTMLElement>(
            "button:not(:disabled)",
          );
        if (!buttons?.length) return;
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", key);
      opener.current?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <button
          className="modal-close"
          onClick={cancel}
          aria-label="확인창 닫기"
        >
          <X size={19} />
        </button>
        <div className="modal-icon">
          <RefreshCw size={23} />
        </div>
        <h2 id={titleId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        <div>
          <button ref={cancelRef} className="button secondary" onClick={cancel}>
            취소
          </button>
          <button className="button danger" onClick={proceed}>
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}
function Title({
  step,
  title,
  desc,
}: {
  step: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="page-title">
      <span>{step}</span>
      <h1>{title}</h1>
      <p>{desc}</p>
    </div>
  );
}
function Field({
  label,
  children,
  htmlFor,
}: {
  label: string;
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
