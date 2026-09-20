/* ============================================================
   假玩家 —— 彩排用

   壓力測試量的是數字，這支是拿來「看」的：開 N 個有名字、有隊伍的
   玩家連上去，投影幕就會出現一整片人。活動前想知道 100 個人的畫面
   長什麼樣、字會不會擠在一起、隊伍顏色分不分得開，開這個就對了。

   它會跟著關卡改變行為（讀 state.control）：
     joystick  一直亂搖
     camera    隨機挑一個「接近目標色」的顏色交出去
     flip/lift 在目標秒數附近隨機做動作

   所以拍照找顏色和火候達人也能在沒有 100 支真手機的情況下先跑一次，
   看看計分、排行榜、投影幕版面長什麼樣。

   跑法：
     npm run fake -- --clients 100
     npm run fake -- --url wss://<app>.fly.dev --clients 120
   ============================================================ */

import WebSocket from "ws";
import { SETTINGS } from "../src/config/settings";
import { teamForSeat } from "../src/shared/teams";
import { fromHex, toHex } from "../src/shared/color";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]?.replace(/^--/, "");
  const v = process.argv[i + 1];
  if (k && v) args.set(k, v);
}

const URL_BASE = args.get("url") ?? "ws://localhost:8080";
const CLIENTS = Number(args.get("clients") ?? 100);
// 沒有房號了，預設就是正式房間。--room 只留給壓力測試隔離用。
const ROOM = (args.get("room") ?? "MAIN").toUpperCase();
const HZ = Number(args.get("hz") ?? 20);

const NAMES = [
  "小明", "阿華", "宗翰", "佩君", "怡君", "家豪", "雅婷", "俊傑",
  "淑芬", "建宏", "美玲", "志明", "欣怡", "冠廷", "詩涵", "承恩",
];

/**
 * 假的縮圖：一張該顏色的 SVG 方塊。
 *
 * 用純色方塊而不是透明的 1×1，是為了讓彩排時投影幕的公布版面看得出來 ——
 * 八個格子排不排得下、名字會不會擠、分數對不對得上。
 */
function fakeThumb(hex: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150">` +
    `<rect width="200" height="150" fill="${hex}"/>` +
    `<rect x="70" y="45" width="60" height="60" fill="none" stroke="#fff" stroke-width="2"/></svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

/** 在目標色附近亂走一段距離，模擬「有人找得準、有人隨便拍」。 */
function nearby(hex: string, spread: number): string {
  const c = fromHex(hex);
  const jitter = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v + (Math.random() - 0.5) * spread)));
  return toHex({ r: jitter(c.r), g: jitter(c.g), b: jitter(c.b) });
}

function connect(i: number): void {
  const sock = new WebSocket(`${URL_BASE}?r=${ROOM}&role=play`);
  // 每個人一個自己的漂移方向，畫面才不會整片往同一邊跑
  let angle = Math.random() * Math.PI * 2;
  let joined = false;
  /** 這一輪交過了沒。state 會一直重送，不擋的話會洗版。 */
  let doneThisRound = false;
  let lastRoundKey = "";
  let flipTimer: ReturnType<typeof setTimeout> | null = null;

  sock.on("open", () => sock.send(JSON.stringify({ t: "seat" })));

  sock.on("message", (raw) => {
    let m: { t?: string; n?: number; v?: Record<string, unknown> };
    try {
      m = JSON.parse(raw.toString()) as typeof m;
    } catch {
      return;
    }

    if (m.t === "seat" && typeof m.n === "number" && !joined) {
      joined = true;
      const name = `${NAMES[i % NAMES.length]}${Math.floor(i / NAMES.length) || ""}`;
      sock.send(
        JSON.stringify({
          t: "player",
          v: { name, team: teamForSeat(m.n, SETTINGS.teamCount), joinedAt: Date.now() },
        }),
      );

      setInterval(() => {
        if (sock.readyState !== WebSocket.OPEN) return;
        // 慢慢轉向，看起來像有人在操作而不是雜訊
        angle += (Math.random() - 0.5) * 0.6;
        sock.send(
          JSON.stringify({
            t: "input",
            v: { v: [Math.cos(angle), Math.sin(angle)], t: Date.now() },
          }),
        );
      }, 1000 / HZ);
      return;
    }

    if (m.t !== "state" || !m.v) return;
    const s = m.v as {
      control?: string;
      accepting?: boolean;
      game?: string;
      round?: number;
      targetColor?: string;
      targetSeconds?: number;
    };

    const roundKey = `${s.game}:${s.round}:${s.accepting}`;
    if (roundKey !== lastRoundKey) {
      lastRoundKey = roundKey;
      doneThisRound = false;
      if (flipTimer) clearTimeout(flipTimer);
      flipTimer = null;
    }
    if (!s.accepting || doneThisRound) return;

    if (s.control === "camera" && s.targetColor) {
      doneThisRound = true;
      // 有人找得準、有人隨便拍：擴散量隨機，分數才會拉得開
      const spread = 20 + Math.random() * 160;
      const hex = nearby(s.targetColor as string, spread);
      setTimeout(
        () => {
          if (sock.readyState !== WebSocket.OPEN) return;
          sock.send(
            JSON.stringify({
              t: "action",
              v: { k: "color", hex, thumb: fakeThumb(hex) },
            }),
          );
        },
        2000 + Math.random() * 20000,
      );
    }

    if ((s.control === "flip" || s.control === "lift") && s.targetSeconds) {
      doneThisRound = true;
      const target = s.targetSeconds * 1000;
      // 誤差常態一點：大多數人差半秒內，少數人差很多
      const err = (Math.random() - 0.5) * (Math.random() < 0.7 ? 1200 : 6000);
      const at = Math.max(300, target + err);
      flipTimer = setTimeout(() => {
        if (sock.readyState !== WebSocket.OPEN) return;
        sock.send(
          JSON.stringify({
            t: "action",
            v: { k: "flip", ms: at, by: Math.random() < 0.85 ? "motion" : "tap" },
          }),
        );
      }, at);
    }
  });

  sock.on("error", () => {});
}

console.log(`${URL_BASE}｜房號 ${ROOM}｜${CLIENTS} 個假玩家，Ctrl+C 結束`);
for (let i = 0; i < CLIENTS; i++) {
  setTimeout(() => connect(i), i * 20);
}
