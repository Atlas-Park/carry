import { useEffect, useState } from "react";

type InstallEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

export const inviteCode = () => {
  const code =
    new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
  return /^[A-Z0-9]{6}$/.test(code) ? code : "";
};

export function PwaTools({ code, home }: { code?: string; home: boolean }) {
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(
    matchMedia("(display-mode: standalone)").matches,
  );
  const [message, setMessage] = useState("");

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

  const share = async () => {
    if (!code) return;
    const url = new URL("/", location.origin);
    url.searchParams.set("room", code);
    try {
      if (navigator.share)
        await navigator.share({
          title: "Carry 팀플 초대",
          text: "같이 팀플을 시작해요",
          url: url.href,
        });
      else {
        await navigator.clipboard.writeText(url.href);
        setMessage("초대 링크를 복사했어요.");
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        setMessage("초대 링크를 복사해서 보내주세요.");
    }
  };

  if (!home && !code) return null;
  return (
    <aside className="pwa-tools">
      <div className="pwa-actions">
        {home && !installed && (
          <button
            type="button"
            onClick={async () => {
              if (install) {
                await install.prompt();
                await install.userChoice;
                setInstall(null);
              } else
                setMessage(
                  "아이폰 Safari: 공유 → 홈 화면에 추가. 안드로이드 Chrome: 메뉴 → 앱 설치 또는 홈 화면에 추가.",
                );
            }}
          >
            홈 화면에 추가하기 ↗
          </button>
        )}
        {code && (
          <button type="button" onClick={() => void share()}>
            초대 링크 공유
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
    </aside>
  );
}
