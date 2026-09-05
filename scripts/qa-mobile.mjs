import { createClient } from "@supabase/supabase-js";
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.CARRY_PLAYWRIGHT_PATH || "playwright"
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const url = process.env.VITE_SUPABASE_URL,
  key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const clients = [],
  sessions = [];
for (let i = 0; i < 2; i++) {
  const c = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await c.auth.signInAnonymously();
  if (error) throw error;
  clients.push(c);
  sessions.push(data.session);
}
async function rpc(c, name, args) {
  const { data, error } = await c.rpc(name, args);
  if (error) throw Error(`${name}: ${error.message}`);
  return data;
}
const [a, b] = clients;
const r = await rpc(a, "create_room", {
  p_name: "[QA] 모바일 드래그 검증",
  p_final_deadline: new Date(Date.now() + 864000000).toISOString(),
  p_member_limit: 2,
  p_member_name: "QA모바일",
  p_kakao_id: "qa-only",
});
console.log("QA_ROOM", r.room_id);
await rpc(a, "save_room_snapshot", { p_room_id: r.room_id, p_state: {} });
await rpc(b, "join_room", {
  p_invite_code: r.invite_code,
  p_member_name: "QA보조",
  p_kakao_id: "qa-only",
});
const cmd = (c, action, payload = {}) =>
  rpc(c, "carry_command", {
    p_room_id: r.room_id,
    p_action: action,
    p_payload: payload,
  });
await cmd(a, "mode", { value: "known" });
let state = await cmd(a, "nominate", { value: r.member_id });
const version = state.room.decision.version;
await cmd(a, "consent", { version });
await cmd(b, "consent", { version });
await cmd(a, "roles", {
  roles: [0, 1].map((i) => ({
    id: `mobile-${i}`,
    name: i ? "보고서 작성" : "자료조사",
    deliverable: "모바일 테스트 결과",
    deadline: new Date(Date.now() + (i + 1) * 86400000).toISOString(),
  })),
});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const authKey = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  await context.addInitScript(
    ({ authKey, session }) =>
      localStorage.setItem(authKey, JSON.stringify(session)),
    { authKey, session: sessions[0] },
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:5181/");
  await page
    .getByRole("button", { name: "다시 들어가기", exact: true })
    .click();
  const first = page.getByRole("button", { name: /자료조사 1지망/ });
  await first.scrollIntoViewIfNeeded();
  const second = page.getByRole("button", { name: /보고서 작성 2지망/ });
  const p = await first.boundingBox(),
    q = await second.boundingBox();
  assert(p && q);
  const cdp = await context.newCDPSession(page),
    x = p.x + p.width / 2,
    y = p.y + p.height / 2,
    end = q.y + q.height / 2;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let i = 1; i <= 12; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + ((end - y) * i) / 12 }],
    });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await page.getByRole("button", { name: /보고서 작성 1지망/ }).waitFor();
  assert.equal(await page.evaluate(() => String(window.getSelection())), "");
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: "/private/tmp/carry-mobile-qa.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "내 희망 순위 제출", exact: true })
    .click();
  await page
    .getByRole("button", { name: "순위 다시 제출", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS 390px touch drag, no text selection, no horizontal overflow, save, no runtime errors",
  );
  await context.close();
} finally {
  await browser.close();
  await Promise.all(clients.map((c) => c.removeAllChannels()));
}
