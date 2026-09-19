/* ============================================================
   投影幕

   它是唯一做全域訂閱的客戶端：state + players + inputs 三個都聽。
   所有運算與渲染都在這裡，手機端只負責送搖桿。

   鍵盤（沿用 orientation 的手感）：
     →        下一關（遊戲可以先吃掉，例如換題目、換字）
     ←        上一關
     T        開始／暫停這一局
     R        重來這一關
     F        全螢幕
     Esc      關卡選單
   ============================================================ */

import "../shared/base.css";
import "./stage.css";
import { svg } from "../shared/qrcode.js";
import { openRoom, playUrl } from "../net/room";
import { createSurface } from "./canvas";
import { Field } from "./render";
import { createGames, type Game, type GameContext } from "./games";
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

  const surface = createSurface($<HTMLCanvasElement>("stage"));
  const field = new Field();
  const games = createGames();
  const ctx: GameContext = {
    field,
    surface,
    publish: (patch) => room.publishState(patch),
  };

  let index = -1;
  let game: Game | null = null;

  function go(next: number): void {
    const clamped = Math.max(0, Math.min(games.length - 1, next));
    if (clamped === index) return;
    game?.exit?.(ctx);
    index = clamped;
    game = games[index] as Game;
    game.enter(ctx);
    $("gameTitle").textContent = game.title;
    $("gameBrief").textContent = game.brief;
    renderMenu();
  }

  function renderMenu(): void {
    $("menu").innerHTML = games
      .map(
        (g, i) =>
          `<li class="${i === index ? "on" : ""}"><b>${i + 1}</b> ${g.title}<span>${g.brief}</span></li>`,
      )
      .join("");
  }

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
  // 實際的移動交給每幀積分 —— 收到 20 Hz 的輸入也能畫出 60 fps 的動作。
  room.onInputs((inputs) => {
    const now = performance.now();
    for (const [uid, input] of Object.entries(inputs)) {
      if (!input?.v) continue;
      field.applyInput(uid, input.v[0] ?? 0, input.v[1] ?? 0, now);
    }
  });

  go(0);

  let last = performance.now();
  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    surface.ctx.fillStyle = "#14141A";
    surface.ctx.fillRect(0, 0, surface.w, surface.h);

    game?.step(dt, now, ctx);
    game?.draw(now, ctx);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.addEventListener("keydown", (e) => {
    // 遊戲先挑走自己要的鍵（換題目、開球…），沒吃掉才輪到主流程。
    if (game?.key?.(e, ctx)) {
      e.preventDefault();
      return;
    }

    switch (e.key) {
      case "ArrowRight":
        go(index + 1);
        break;
      case "ArrowLeft":
        go(index - 1);
        break;
      case "f":
      case "F":
        void (document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen());
        break;
      case "Escape":
        $("menu").classList.toggle("open");
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  $("menu").addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("li");
    if (!li) return;
    go([...$("menu").children].indexOf(li));
    $("menu").classList.remove("open");
  });
}

void main();
