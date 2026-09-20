/* ============================================================
   遊戲五：火候達人（個人賽）

   出題「煎素火腿，10 秒翻面」。倒數開始後，玩家要在正確的時間點
   把手機翻面（螢幕朝下）。誤差越小分數越高。

   翻面怎麼判定：用加速度計的 z 軸（play/flip.ts）。
   螢幕朝上 z ≈ +9.8，朝下 z ≈ -9.8，穿過零點就是翻面了。
   比用陀螺儀積分角度可靠得多 —— 積分會飄，而且不同手機的軸向不一樣。

   ⚠️ iOS 一定要使用者點一下才能拿到感測器權限，而且拒絕之後要
   重新載入頁面才能再問。所以手機端一定有一顆「按這裡代表翻面」的
   備援按鈕，不能讓任何人卡在這一關。action 裡會記錄是 motion 還是 tap，
   現場可以看到有多少人的感測器沒作用。

   這一關沒有「提前翻」的懲罰上限差異：早翻 3 秒和晚翻 3 秒一樣扣分。
   煎東西本來就是兩邊都不對。
   ============================================================ */

import type { PlayerAction } from "../../net/schema";
import type { Game, GameContext } from "./types";

interface Dish {
  name: string;
  /** 幾秒翻面 */
  seconds: number;
}

const DISHES: Dish[] = [
  { name: "煎素火腿", seconds: 10 },
  { name: "煎豆包", seconds: 7 },
  { name: "翻炒高麗菜", seconds: 14 },
];

/** 誤差幾秒就掉到 0 分 */
const ZERO_AT = 5;
/** 開始之後最多等這麼久，沒翻就算沒交 */
const GRACE_MS = 8000;

export function createHeatMasterGame(): Game {
  let index = 0;
  let running = false;
  let startedAt = 0;
  /** 這一題誰在第幾毫秒翻的 */
  const flips = new Map<string, { ms: number; score: number; by: "motion" | "tap" }>();

  function dish(): Dish {
    return DISHES[index] as Dish;
  }

  function scoreFor(ms: number): number {
    const errSec = Math.abs(ms / 1000 - dish().seconds);
    return Math.max(0, Math.round(100 * (1 - errSec / ZERO_AT)));
  }

  function announce(ctx: GameContext, hint: string): void {
    ctx.publish({
      phase: "playing",
      game: "heatmaster",
      round: index + 1,
      control: "flip",
      targetSeconds: dish().seconds,
      accepting: running,
      hint,
      options: [],
      targetColor: "",
    });
  }

  function load(ctx: GameContext): void {
    running = false;
    flips.clear();
    for (const a of ctx.field.actors.values()) {
      a.flag = false;
      a.tint = null;
    }
    announce(ctx, `第 ${index + 1} 題：${dish().name}，${dish().seconds} 秒翻面`);
  }

  return {
    id: "heatmaster",
    title: "火候達人",
    brief: "個人賽。T 開始計時，玩家在指定秒數把手機翻面。→ 換下一道菜。",

    enter(ctx) {
      index = 0;
      ctx.field.reset(false);
      load(ctx);
    },

    step(_dt, now, ctx) {
      if (running && now - startedAt > dish().seconds * 1000 + GRACE_MS) {
        running = false;
        announce(ctx, `結束！${flips.size} 個人翻了`);
      }
    },

    action(uid, a: PlayerAction, ctx) {
      if (a.k !== "flip" || !running) return;
      // 一題只能翻一次。翻過就不理後面的，不然搖一搖就刷分了。
      if (flips.has(uid)) return;
      const actor = ctx.field.actors.get(uid);
      if (!actor) return;

      const score = scoreFor(a.ms);
      flips.set(uid, { ms: a.ms, score, by: a.by });
      actor.score += score;
      actor.flag = true;
      // 翻得準的偏綠、翻得爛的偏紅，投影幕上一片顏色就看得出全場火候
      const good = score / 100;
      actor.tint = `hsl(${Math.round(good * 120)} 70% 55%)`;
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const d = dish();
      const elapsed = running ? (now - startedAt) / 1000 : 0;
      const target = d.seconds;

      g.textAlign = "center";
      g.textBaseline = "middle";

      // 鍋子：一個大圓，越接近翻面時間越紅
      const heat = Math.min(1, elapsed / target);
      const cx = w / 2;
      const cy = h * 0.42;
      const rr = Math.min(w, h) * 0.22;

      g.fillStyle = `hsl(${Math.round(30 - heat * 30)} ${Math.round(40 + heat * 45)}% ${Math.round(28 + heat * 18)}%)`;
      g.beginPath();
      g.arc(cx, cy, rr, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(255,255,255,.25)";
      g.lineWidth = unit * 0.8;
      g.stroke();

      // 目標時間那一圈，走到滿圈就是該翻的時候
      g.strokeStyle = "#F2A72C";
      g.lineWidth = unit * 1.4;
      g.beginPath();
      g.arc(cx, cy, rr + unit * 2.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, heat));
      g.stroke();

      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 6)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(d.name, cx, cy - unit * 3);
      g.font = `900 ${Math.round(unit * 10)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(running ? elapsed.toFixed(1) : `${target}s`, cx, cy + unit * 4);

      g.font = `700 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(
        running ? `${target} 秒翻面　已翻 ${flips.size}` : `按 T 開始　已翻 ${flips.size}`,
        cx,
        cy + rr + unit * 8,
      );

      ctx.field.drawActors(ctx.surface, now, { radius: unit * 1.4, names: false });

      // 前五名，連誤差一起寫出來，現場才吵得起來
      const top = [...ctx.field.actors.entries()]
        .filter(([uid]) => flips.has(uid))
        .sort((a, b) => (flips.get(b[0])?.score ?? 0) - (flips.get(a[0])?.score ?? 0))
        .slice(0, 5);

      if (top.length > 0) {
        const boxH = unit * (4 + top.length * 4);
        g.fillStyle = "rgba(10,10,14,.8)";
        g.fillRect(unit * 2, h - boxH - unit * 2, unit * 36, boxH);
        g.textAlign = "left";
        g.fillStyle = "#FFFFFF";
        g.font = `900 ${Math.round(unit * 2.4)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText("火候最準的", unit * 4, h - boxH + unit * 0.5);

        top.forEach(([uid, actor], i) => {
          const f = flips.get(uid);
          if (!f) return;
          const y = h - boxH + unit * (4.5 + i * 4);
          const err = f.ms / 1000 - target;
          g.font = `700 ${Math.round(unit * 2.2)}px system-ui, "Noto Sans TC", sans-serif`;
          g.fillStyle = "#FFFFFF";
          g.fillText(actor.name, unit * 4, y);
          g.fillStyle = "rgba(255,255,255,.65)";
          g.fillText(`${err >= 0 ? "+" : ""}${err.toFixed(2)}s`, unit * 18, y);
          // tap 的人標一下，現場才知道有多少支手機的感測器沒作用
          if (f.by === "tap") g.fillText("（按鈕）", unit * 26, y);
          g.textAlign = "right";
          g.fillStyle = "#FFFFFF";
          g.fillText(`${f.score}`, unit * 36, y);
          g.textAlign = "left";
        });
      }
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        running = !running;
        if (running) {
          startedAt = performance.now();
          flips.clear();
          for (const a of ctx.field.actors.values()) a.flag = false;
        }
        announce(ctx, running ? `${dish().name}　開始計時！` : "暫停");
        return true;
      }
      if (e.key === "ArrowRight" && index < DISHES.length - 1) {
        index++;
        load(ctx);
        return true;
      }
      if (e.key === "r" || e.key === "R") {
        load(ctx);
        return true;
      }
      return false;
    },
  };
}
