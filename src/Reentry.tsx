import { useEffect, useRef, useState } from "react";
import type { Room, RoomRecord } from "./App";
import { ensureAnonymousSession, supabase } from "./supabase";

async function rpc(name: string, args: Record<string, unknown>) {
  await ensureAnonymousSession();
  if (!supabase) throw new Error("서버 연결을 확인해주세요.");
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}
export function ReentryGate({
  token,
  done,
  cancel,
}: {
  token: string;
  done: (record: RoomRecord, memberId: string) => void;
  cancel: () => void;
}) {
  const [info, setInfo] = useState<{ name: string; roomName: string } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let alive = true;
    void rpc("carry_preview_reentry", { p_token: token })
      .then((data) => {
        if (alive) setInfo(data);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [token]);
  return (
    <main className="app-shell">
      <section className="page reentry-gate">
        <p className="eyebrow">다시 만나서 반가워요</p>
        <h1>내 팀플로 돌아가기</h1>
        {info ? (
          <>
            <p>{info.roomName}</p>
            <h2>{info.name}님으로 재입장해요.</h2>
            <p>
              기존 역할과 진행 상황은 그대로 유지돼요. 이전 접속의 이 방 권한은
              종료됩니다.
            </p>
            <label className="reentry-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              네, 제가 {info.name}입니다.
            </label>
            <button
              className="primary"
              disabled={!confirmed || busy}
              onClick={async () => {
                if (lock.current) return;
                lock.current = true;
                setBusy(true);
                setError("");
                try {
                  const data = await rpc("carry_redeem_reentry", {
                    p_token: token,
                    p_confirm: confirmed,
                  });
                  done(data.state, data.member_id);
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "다시 시도해주세요.",
                  );
                } finally {
                  lock.current = false;
                  setBusy(false);
                }
              }}
            >
              {busy ? "연결 중…" : "기존 역할로 재입장"}
            </button>
          </>
        ) : (
          !error && <p role="status">재입장 링크를 확인하고 있어요…</p>
        )}
        {error && <p role="alert">{error}</p>}
        <button className="text-button" onClick={cancel}>
          홈으로
        </button>
      </section>
    </main>
  );
}

export function ReentryMenu({ room }: { room: Room }) {
  const [link, setLink] = useState("");
  const [targetName, setTargetName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const me = room.members.find((m) => m.isMe);
  const head = room.leaderId ?? room.members.find((m) => m.isCreator)?.id;
  const targets = room.members.filter(
    (m) => m.id !== me?.id && (me?.id === head || m.id === head),
  );
  useEffect(() => {
    setLink("");
    setMessage("");
  }, [room.id]);
  return (
    <details className="reentry-menu">
      <summary>팀원 재입장 돕기</summary>
      <p>
        접속을 잃은 팀원에게 개인 카톡으로 보내주세요. 링크는 30분 동안 한 번만
        사용할 수 있어요.
      </p>
      {targets.map((member) => (
        <div className="reentry-person" key={member.id}>
          <span>
            {member.name}
            {member.id === head ? " · 팀장" : ""}
          </span>
          <button
            disabled={busy}
            onClick={async () => {
              if (lock.current) return;
              lock.current = true;
              setBusy(true);
              setLink("");
              setMessage("");
              try {
                const token = await rpc("carry_issue_reentry", {
                  p_room_id: room.id,
                  p_member_id: member.id,
                });
                const url = new URL("/", location.origin);
                url.hash = new URLSearchParams({ reenter: token }).toString();
                setLink(url.href);
                setTargetName(member.name);
              } catch (e) {
                setMessage(
                  e instanceof Error ? e.message : "다시 시도해주세요.",
                );
              } finally {
                lock.current = false;
                setBusy(false);
              }
            }}
          >
            재입장 링크 만들기
          </button>
        </div>
      ))}
      {!targets.length && <p>다른 팀원이 있어야 재입장을 도울 수 있어요.</p>}
      {link && (
        <div className="reentry-link">
          <label>
            {targetName}님 전용 링크
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
          </label>
          <p>
            새 링크를 만들면 이전 링크는 만료돼요. 단체방에는 보내지 마세요.
          </p>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setMessage("링크를 복사했어요. 개인 카톡으로 보내주세요.");
              } catch {
                setMessage("위 링크를 길게 눌러 직접 복사해주세요.");
              }
            }}
          >
            링크 복사
          </button>
          {typeof navigator.share === "function" && (
            <button
              onClick={async () => {
                try {
                  await navigator.share({
                    title: `${targetName}님 Carry 재입장`,
                    url: link,
                  });
                } catch (e) {
                  if (!(e instanceof DOMException && e.name === "AbortError"))
                    setMessage("링크를 복사해서 보내주세요.");
                }
              }}
            >
              보내기
            </button>
          )}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {!!room.reentries?.length && (
        <details>
          <summary>최근 재입장 기록</summary>
          {room.reentries.map((entry, i) => (
            <p key={i}>
              {entry.name} · {new Date(entry.at).toLocaleString("ko-KR")}
            </p>
          ))}
        </details>
      )}
    </details>
  );
}
