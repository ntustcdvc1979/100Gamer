/* ============================================================
   假玩家 —— 彩排用

   壓力測試量的是數字，這支是拿來「看」的：開 N 個有名字、有隊伍的
   玩家連上去，投影幕就會出現一整片人。活動前想知道 100 個人的畫面
   長什麼樣、字會不會擠在一起、隊伍顏色分不分得開，開這個就對了。

   跑法：
     npm run fake -- --clients 100
     npm run fake -- --url wss://<app>.fly.dev --clients 120 --room PARTY
   ============================================================ */

import WebSocket from "ws";
import { SETTINGS } from "../src/config/settings";
import { teamForSeat } from "../src/shared/teams";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]?.replace(/^--/, "");
  const v = process.argv[i + 1];
  if (k && v) args.set(k, v);
}

const URL_BASE = args.get("url") ?? "ws://localhost:8080";
const CLIENTS = Number(args.get("clients") ?? 100);
const ROOM = (args.get("room") ?? SETTINGS.room).toUpperCase();
const HZ = Number(args.get("hz") ?? 20);

const NAMES = [
  "小明", "阿華", "宗翰", "佩君", "怡君", "家豪", "雅婷", "俊傑",
  "淑芬", "建宏", "美玲", "志明", "欣怡", "冠廷", "詩涵", "承恩",
];

function connect(i: number): void {
  const sock = new WebSocket(`${URL_BASE}?r=${ROOM}&role=play`);
  // 每個人一個自己的漂移方向，畫面才不會整片往同一邊跑
  let angle = Math.random() * Math.PI * 2;

  sock.on("open", () => sock.send(JSON.stringify({ t: "seat" })));

  sock.on("message", (raw) => {
    let m: { t?: string; n?: number };
    try {
      m = JSON.parse(raw.toString()) as typeof m;
    } catch {
      return;
    }
    if (m.t !== "seat" || typeof m.n !== "number") return;

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
  });

  sock.on("error", () => {});
}

console.log(`${URL_BASE}｜房號 ${ROOM}｜${CLIENTS} 個假玩家，Ctrl+C 結束`);
for (let i = 0; i < CLIENTS; i++) {
  setTimeout(() => connect(i), i * 20);
}
