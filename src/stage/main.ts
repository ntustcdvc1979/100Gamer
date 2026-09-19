/* ============================================================
   投影幕

   它是唯一做全域訂閱的客戶端：state + players + inputs 三個都聽。
   所有運算與渲染都在這裡，手機端只負責送搖桿。
   ============================================================ */

import "../shared/base.css";
import "./stage.css";
import { svg } from "../shared/qrcode.js";
import { openRoom, playUrl } from "../net/room";
import { Field } from "./render";
import type { Player } from "../net/schema";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const statusEl = $("status");
const statusText = $("statusText");
const countEl = $("count");

function setStatus(ok: boolean, text: string): void {
  statusEl.classList.toggle("on", ok);
  statusText.textContent = text;
}

async function main(): Promise<void> {
  const room = await openRoom("stage");

  $("room").textContent = room.code;
  if (room.kind === "local") {
    // 本機模式一定要看得出來。這一格被蓋成「已連線」的話，主持人會以為
    // 手機都同步好了才開場 —— 那是現場最貴的誤會。
    setStatus(false, "本機模式");
  } else {
    setStatus(false, "連線中…");
    room.onConnection((ok) => setStatus(ok, ok ? "已連線" : "連線中斷"));
  }

  if (!room.isHost) {
    setStatus(false, "已有另一台投影幕");
  }

  const url = playUrl();
  $("url").textContent = url;
  try {
    $("qr").innerHTML = svg(url);
  } catch {
    $("qr").textContent = "QR 產生失敗";
  }

  const field = new Field($<HTMLCanvasElement>("stage"));
  field.start();

  // 名單：低頻，只有人加入或離開時才動。
  room.onPlayers((players: Record<string, Player>) => {
    const uids = new Set(Object.keys(players));
    field.retain(uids);
    for (const [uid, p] of Object.entries(players)) {
      if (!p?.name || !p.team) continue;
      field.upsert(uid, p.name, p.team);
    }
    countEl.textContent = String(uids.size);
    $("qrPanel").classList.toggle("small", uids.size > 0);
  });

  // 輸入：高頻，這是整個系統的熱路徑。這裡只把向量抄進記憶體，
  // 實際的移動交給 render 的每幀積分 —— 收到 5 Hz 的輸入也能畫出 60 fps 的動作。
  room.onInputs((inputs) => {
    const now = performance.now();
    for (const [uid, input] of Object.entries(inputs)) {
      if (!input?.v) continue;
      field.applyInput(uid, input.v[0] ?? 0, input.v[1] ?? 0, now);
    }
  });

  room.publishStateNow({ phase: "lobby" }).catch(() => {});

  window.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") {
      void (document.fullscreenElement
        ? document.exitFullscreen()
        : document.documentElement.requestFullscreen());
    }
  });
}

void main();
