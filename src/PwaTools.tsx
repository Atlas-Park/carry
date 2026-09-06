import { useEffect, useState } from "react";
import { ensureAnonymousSession, supabase } from "./supabase";

type InstallEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
type LeftRoom = {
  roomId: string;
  record: { room: { name: string } };
  left: boolean;
  canRestore: boolean;
};
export const inviteCode = () => {
  const code =
    new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
  return /^[A-Z0-9]{6}$/.test(code) ? code : "";
};
export function PwaTools({ code }: { code?: string }) {
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(
    matchMedia("(display-mode: standalone)").matches,
  );
  const [message, setMessage] = useState("");
  const [key, setKey] = useState("");
  const [issued, setIssued] = useState("");
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<LeftRoom[]>([]);
  useEffect(() => {
    const before = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallEvent);
    };
    const done = () => {
      setInstalled(true);
      setInstall(null);
    };
    window.addEventListener("beforeinstallprompt", before);
    window.addEventListener("appinstalled", done);
    if ("serviceWorker" in navigator && import.meta.env.PROD)
      void navigator.serviceWorker
        .register("/sw.js")
        .catch(() => setMessage("설치 준비에 실패했어요. 새로고침해주세요."));
    return () => {
      window.removeEventListener("beforeinstallprompt", before);
      window.removeEventListener("appinstalled", done);
    };
  }, []);
  const task = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "다시 시도해주세요.");
    } finally {
      setBusy(false);
    }
  };
  const rpc = async (name: string, args?: Record<string, unknown>) => {
    if (!supabase) throw new Error("서버 연결을 확인해주세요.");
    await ensureAnonymousSession();
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  };
  const copy = async (text: string) => {
    if (!navigator.clipboard)
      throw new Error(
        "자동 복사를 지원하지 않아요. 표시된 내용을 직접 복사해주세요.",
      );
    await navigator.clipboard.writeText(text);
    setMessage("복사했어요.");
  };
  return (
    <aside className="pwa-tools">
      <div className="pwa-actions">
        {!installed && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void task(async () => {
                if (install) {
                  await install.prompt();
                  await install.userChoice;
                  setInstall(null);
                } else
                  setMessage(
                    "아이폰 Safari: 공유 → 홈 화면에 추가. 안드로이드 Chrome: 메뉴 → 앱 설치 또는 홈 화면에 추가. 카톡 안에서는 기본 브라우저로 먼저 열어주세요.",
                  );
              })
            }
          >
            홈 화면에 설치
          </button>
        )}
        {code && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void task(async () => {
                const url = new URL("/", location.origin);
                url.searchParams.set("room", code);
                if (navigator.share) {
                  try {
                    await navigator.share({
                      title: "Carry 팀플 초대",
                      text: "같이 팀플을 시작해요",
                      url: url.href,
                    });
                  } catch (e) {
                    if (!(e instanceof DOMException && e.name === "AbortError"))
                      throw e;
                  }
                } else await copy(url.href);
              })
            }
          >
            초대 링크 공유
          </button>
        )}
      </div>
      <details>
        <summary>내 방 지키기 · 복구</summary>
        <p>
          브라우저 데이터 삭제·휴대폰 변경에 대비해 복구 키를 따로 저장해주세요.
          초대 코드만으로는 내 신원을 복구할 수 없어요.
        </p>
        <p>
          복구 키는 비밀번호와 같아요. 팀원에게 공유하지 마세요. 재발급하면 이전
          키는 사용할 수 없어요.
        </p>
        <button
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                "새 복구 키를 발급할까요? 이전에 저장한 키가 있다면 더 이상 사용할 수 없어요.",
              )
            )
              void task(async () => {
                setIssued(await rpc("carry_issue_recovery_key"));
                setMessage(
                  "복구 키를 안전한 곳에 저장해주세요. 새로고침하면 다시 표시되지 않아요.",
                );
              });
          }}
        >
          복구 키 발급 / 재발급
        </button>
        {issued && (
          <div>
            <textarea aria-label="발급된 복구 키" readOnly value={issued} />
            <button onClick={() => void task(() => copy(issued))}>
              키 복사
            </button>
          </div>
        )}
        <label>
          저장해둔 복구 키
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="복구 키 붙여넣기"
          />
        </label>
        <button
          disabled={busy || !key.trim()}
          onClick={() =>
            void task(async () => {
              await rpc("carry_recover", { p_key: key.trim().toLowerCase() });
              setKey("");
              window.dispatchEvent(new Event("carry-refresh"));
              setMessage("본인 확인 완료. 내 방 목록을 다시 불러와요.");
            })
          }
        >
          내 방 복구
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void task(async () => {
              const rooms = (await rpc("carry_my_rooms")) as LeftRoom[];
              setLeft(rooms.filter((r) => r.left && r.canRestore));
              setMessage(
                rooms.some((r) => r.left && r.canRestore)
                  ? "참가가 마감되지 않은 방에 다시 들어갈 수 있어요."
                  : "다시 참여할 수 있는 나간 방이 없어요.",
              );
            })
          }
        >
          나간 방 찾기
        </button>
        {left.map((r) => (
          <div key={r.roomId}>
            <span>{r.record.room.name}</span>
            <button
              disabled={busy}
              onClick={() =>
                void task(async () => {
                  await rpc("carry_restore_room", { p_room_id: r.roomId });
                  setLeft((previous) =>
                    previous.filter((x) => x.roomId !== r.roomId),
                  );
                  window.dispatchEvent(new Event("carry-refresh"));
                  setMessage("내 방 목록에 복원했어요.");
                })
              }
            >
              다시 참여
            </button>
          </div>
        ))}
      </details>
      {message && <p role="status">{message}</p>}
    </aside>
  );
}
