/* ============================================================
   遊戲五：火候達人（個人賽）

   六道菜，每一道要在指定的秒數做一個動作。誤差越小分數越高。

   三種動作：
     lift   把手機提起來（煎蛋餅起鍋、薯條起鍋、掀鍋蓋）
     flip   把手機翻面（翻素火腿、炒高麗菜）
     shake  晃手機（撒胡椒粉）

   ⚠️ 投影幕上的秒數會在 2 秒內淡掉。

   這一關的樂趣就是「用身體去數秒」，把碼表放在畫面上就沒了。
   所以數字和進度圈都只在前兩秒看得到，之後全場只能靠自己數。
   鍋子的顏色也在兩秒內就燒到定色，不會變成另一個計時器。

   ⚠️ 這一關不畫玩家的圓圈。

   一百個點在鍋子旁邊飄來飄去，唯一的作用是讓人看不清楚鍋子和秒數。
   這一關要看的是鍋子、是誰翻得準，不是誰在線上。

   動作怎麼判定：用加速度計（play/flip.ts）。
   flip 看 z 軸從 +9.8 穿到 -9.8；lift 看合成加速度偏離重力多少；
   shake 看短時間內來回震盪幾次。比陀螺儀積分角度可靠得多 ——
   積分會飄，而且不同手機的軸向不一樣。

   ⚠️ iOS 一定要使用者點一下才能拿到感測器權限，而且拒絕之後要
   重新載入頁面才能再問。所以手機端一定有一顆備援按鈕，
   而且畫面上會顯示「已偵測到感應器」還是「沒有」，
   讓人在開始之前就知道自己要用哪一種。
   action 裡會記錄是 motion 還是 tap，現場看得到有多少人的感測器沒作用。
   ============================================================ */

import type { PlayerAction } from "../../net/schema";
import type { Game, GameContext } from "./types";

interface Dish {
  name: string;
  /** 幾秒做動作 */
  seconds: number;
  gesture: "flip" | "lift" | "shake";
  /** 投影幕與手機上寫的動作提示 */
  verb: string;
}

/** 六道菜。要改秒數或順序改這裡就好。 */
const DISHES: Dish[] = [
  { name: "煎蛋餅", seconds: 7, gesture: "lift", verb: "把手機提起來（起鍋）" },
  { name: "炸薯條起鍋", seconds: 6, gesture: "lift", verb: "把手機提起來" },
  { name: "掀鍋蓋", seconds: 15, gesture: "lift", verb: "把手機提起來" },
  { name: "翻素火腿", seconds: 10, gesture: "flip", verb: "把手機翻面" },
  { name: "炒高麗菜", seconds: 12, gesture: "flip", verb: "把手機翻面（翻動）" },
  { name: "撒胡椒粉", seconds: 5, gesture: "shake", verb: "晃手機" },
];

/** 誤差幾秒就掉到 0 分 */
const ZERO_AT = 5;
/** 開始之後最多等這麼久，沒做動作就算沒交 */
const GRACE_MS = 8000;
/** 秒數與進度圈在幾秒內淡掉 */
const HIDE_AFTER = 2;

export function createHeatMasterGame(): Game {
  let index = 0;
  let running = false;
  let startedAt = 0;
  /** 這一題誰在第幾毫秒做動作 */
  const acts = new Map<string, { ms: number; score: number; by: "motion" | "tap" }>();

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
      control: "motion",
      gesture: dish().gesture,
      targetSeconds: dish().seconds,
      accepting: running,
      revealed: false,
      hint,
      options: [],
      targetColor: "",
    });
  }

  function load(ctx: GameContext): void {
    running = false;
    acts.clear();
    announce(ctx, `第 ${index + 1} 題：${dish().name}，${dish().seconds} 秒${dish().verb}`);
  }

  return {
    id: "heatmaster",
    title: "火候達人",
    brief: "個人賽，請依畫面上的指令在最精準的時間動作。",

    enter(ctx) {
      index = 0;
      ctx.field.reset(false);
      load(ctx);
    },

    step(_dt, now, ctx) {
      if (running && now - startedAt > dish().seconds * 1000 + GRACE_MS) {
        running = false;
        announce(ctx, `結束！${acts.size} 個人做了動作`);
      }
    },

    action(uid, a: PlayerAction, ctx) {
      if (a.k !== "flip" || !running) return;
      // 一題只能做一次。做過就不理後面的，不然一直搖就刷分了。
      if (acts.has(uid)) return;
      const actor = ctx.field.actors.get(uid);
      if (!actor) return;

      const score = scoreFor(a.ms);
      acts.set(uid, { ms: a.ms, score, by: a.by });
      actor.score += score;
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const d = dish();
      const elapsed = running ? (now - startedAt) / 1000 : 0;

      g.textAlign = "center";
      g.textBaseline = "middle";

      // 前 HIDE_AFTER 秒看得到，之後淡掉。這一關就是要大家自己數。
      const reveal = running ? Math.max(0, 1 - elapsed / HIDE_AFTER) : 1;

      // 鍋子。熱度也在兩秒內燒到定色，不然它會變成另一個碼表。
      const heat = Math.min(1, elapsed / HIDE_AFTER);
      const cx = w / 2;
      const cy = h * 0.42;
      const rr = Math.min(w, h) * 0.24;

      g.fillStyle = `hsl(${Math.round(30 - heat * 30)} ${Math.round(40 + heat * 45)}% ${Math.round(28 + heat * 18)}%)`;
      g.beginPath();
      g.arc(cx, cy, rr, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "rgba(255,255,255,.25)";
      g.lineWidth = unit * 0.8;
      g.stroke();

      // 進度圈也要淡掉 —— 它比數字更好讀，留著等於沒藏
      if (reveal > 0.01) {
        g.save();
        g.globalAlpha = reveal;
        g.strokeStyle = "#F2A72C";
        g.lineWidth = unit * 1.4;
        g.beginPath();
        g.arc(
          cx, cy, rr + unit * 2.5,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * Math.min(1, elapsed / d.seconds),
        );
        g.stroke();
        g.restore();
      }

      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 6)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(d.name, cx, cy - unit * 3);

      if (running) {
        g.save();
        g.globalAlpha = reveal;
        g.font = `900 ${Math.round(unit * 10)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(elapsed.toFixed(1), cx, cy + unit * 4);
        g.restore();
        if (reveal < 0.15) {
          g.save();
          g.globalAlpha = 0.5;
          g.font = `900 ${Math.round(unit * 5)}px system-ui, "Noto Sans TC", sans-serif`;
          g.fillText("？", cx, cy + unit * 4);
          g.restore();
        }
      } else {
        g.font = `900 ${Math.round(unit * 10)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(`${d.seconds}s`, cx, cy + unit * 4);
      }

      g.font = `700 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(
        running
          ? `${d.seconds} 秒時${d.verb}　${acts.size}人已完成`
          : `　${d.seconds} 秒時${d.verb}`,
        cx,
        cy + rr + unit * 7,
      );

      // 這一關刻意不畫玩家的圓圈：一百個點飄在鍋子旁邊只會擋住秒數。

      // 前五名，連誤差一起寫出來，現場才吵得起來
      const top = [...ctx.field.actors.entries()]
        .filter(([uid]) => acts.has(uid))
        .sort((a, b) => (acts.get(b[0])?.score ?? 0) - (acts.get(a[0])?.score ?? 0))
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
          const f = acts.get(uid);
          if (!f) return;
          const y = h - boxH + unit * (4.5 + i * 4);
          const err = f.ms / 1000 - d.seconds;
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

    running: () => running,

    run(on, ctx) {
      if (running === on) return true;
      running = on;
      if (on) {
        startedAt = performance.now();
        acts.clear();
      }
      announce(ctx, on ? `${dish().name}　開始！自己數 ${dish().seconds} 秒` : "暫停");
      return true;
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        running = !running;
        if (running) {
          startedAt = performance.now();
          acts.clear();
        }
        announce(ctx, running ? `${dish().name}　開始！自己數 ${dish().seconds} 秒` : "暫停");
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
