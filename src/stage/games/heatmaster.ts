/* ============================================================
   遊戲五：火候達人（個人賽）

   八道菜。前六道要在指定的秒數做一個動作，誤差越小分數越高；
   第七道按鈕開燈（真的開手電筒），第八道端湯比的是「還剩多少」。

   五種動作：
     lift   把手機提起來（煎蛋餅起鍋、薯條起鍋、掀鍋蓋）
     flip   把手機翻面（翻素火腿、炒高麗菜）
     shake  晃手機（撒胡椒粉）
     torch  按鈕開烤箱燈 —— 會真的把手機的手電筒打開，全場一起亮
     tilt   傾斜手機端湯，唯一一道不比時間點的

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
import { DISPLAY_ORDER, TEAMS } from "../../shared/teams";
import { bigText, card, font, pikmin, roundRect, shade, sky, woodSign } from "../cartoon";
import type { Game, GameContext } from "./types";

interface Dish {
  name: string;
  /** timing 是「在第幾秒做一次動作」，soup 是「撐幾秒不要把湯灑掉」 */
  mode: "timing" | "soup";
  /** timing：第幾秒做動作。soup：要端幾秒。 */
  seconds: number;
  gesture: "flip" | "lift" | "shake" | "torch" | "tilt";
  /** 投影幕與手機上寫的動作提示 */
  verb: string;
}

/**
 * 八道菜。要改秒數或順序改這裡就好。
 *
 * 前六道是同一種玩法（自己數秒，在對的時間做一個動作），
 * 最後兩道刻意換掉手感，免得八題下來變成同一題出八次：
 *   烤箱焗烤  按鈕開燈，而且是真的把手電筒打開 —— 全場會同時亮起來
 *   端湯      唯一一道不比時間點的，比的是「撐到最後還剩多少湯」
 */
const DISHES: Dish[] = [
  { name: "煎蛋餅", mode: "timing", seconds: 7, gesture: "lift", verb: "把手機提起來（起鍋）" },
  { name: "炸薯條起鍋", mode: "timing", seconds: 6, gesture: "lift", verb: "把手機提起來" },
  { name: "掀鍋蓋", mode: "timing", seconds: 15, gesture: "lift", verb: "把手機提起來" },
  { name: "翻素火腿", mode: "timing", seconds: 10, gesture: "flip", verb: "把手機翻面" },
  { name: "炒高麗菜", mode: "timing", seconds: 12, gesture: "flip", verb: "把手機翻面（翻動）" },
  { name: "撒胡椒粉", mode: "timing", seconds: 5, gesture: "shake", verb: "晃手機" },
  { name: "烤箱焗烤", mode: "timing", seconds: 8, gesture: "torch", verb: "按鈕開烤箱燈" },
  { name: "端湯上桌", mode: "soup", seconds: 20, gesture: "tilt", verb: "傾斜手機保持平衡，別把湯灑了" },
];

/** 鍋子裡每一道菜的顏色（照 DISHES 的順序）。焗烤和端湯各自有道具，不用這裡。 */
const FOOD = ["#F6D365", "#E9B44C", "#D9C7A0", "#F0A1A1", "#6DBE45", "#E8D9B8"];

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

  /** 開始那一刻投影幕上的提示。端湯跟其他七道的講法不一樣。 */
  function startHint(): string {
    const d = dish();
    return d.mode === "soup"
      ? `${d.name}　開始！撐 ${d.seconds} 秒`
      : `${d.name}　開始！自己數 ${d.seconds} 秒`;
  }

  function load(ctx: GameContext): void {
    running = false;
    acts.clear();
    const d = dish();
    announce(
      ctx,
      d.mode === "soup"
        ? `第 ${index + 1} 題：${d.name}，撐 ${d.seconds} 秒，${d.verb}`
        : `第 ${index + 1} 題：${d.name}，${d.seconds} 秒${d.verb}`,
    );
  }

  return {
    id: "heatmaster",
    title: "火候達人",
    cartoon: true,
    brief: "個人賽，請依畫面上的指令在最精準的時間動作。",

    enter(ctx) {
      index = 0;
      ctx.field.reset(false);
      load(ctx);
    },

    step(_dt, now, ctx) {
      if (!running) return;
      const d = dish();
      /* 端湯的收尾寬限只要 2 秒：手機是自己跑完整段模擬再回報結果的，
         時間一到大家幾乎同時送上來，不用像「等人做動作」那樣留 8 秒。 */
      const grace = d.mode === "soup" ? 2000 : GRACE_MS;
      if (now - startedAt > d.seconds * 1000 + grace) {
        running = false;
        ctx.sfx("end");
        announce(
          ctx,
          d.mode === "soup"
            ? `結束！${acts.size} 個人端到桌上`
            : `結束！${acts.size} 個人做了動作`,
        );
      }
    },

    action(uid, a: PlayerAction, ctx) {
      if (!running) return;
      // 一題只能做一次。做過就不理後面的，不然一直搖就刷分了。
      if (acts.has(uid)) return;
      const actor = ctx.field.actors.get(uid);
      if (!actor) return;

      if (a.k === "soup" && dish().mode === "soup") {
        // 端湯比的是剩多少，直接當分數（0..100）
        const score = Math.max(0, Math.min(100, Math.round(a.left)));
        acts.set(uid, { ms: 0, score, by: "motion" });
        actor.score += score;
        return;
      }

      if (a.k !== "flip" || dish().mode !== "timing") return;
      const score = scoreFor(a.ms);
      acts.set(uid, { ms: a.ms, score, by: a.by });
      actor.score += score;
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const d = dish();
      const elapsed = running ? (now - startedAt) / 1000 : 0;

      // 廚房：暖色的天空當牆，下面一張木頭流理台
      sky(g, w, h, now, true);
      const counterY = h * 0.72;
      const wood = g.createLinearGradient(0, counterY, 0, h);
      wood.addColorStop(0, "#C98A52");
      wood.addColorStop(1, "#9A6232");
      g.fillStyle = wood;
      g.fillRect(0, counterY, w, h - counterY);
      g.fillStyle = "#E3A86C";
      g.fillRect(0, counterY, w, unit * 1.2);

      // 菜名掛在木牌上
      woodSign(g, w / 2, unit * 9, `第 ${index + 1} 道・${d.name}`, unit * 4, unit);

      // 前 HIDE_AFTER 秒看得到，之後淡掉。這一關就是要大家自己數。
      const reveal = running ? Math.max(0, 1 - elapsed / HIDE_AFTER) : 1;
      // 熱度也在兩秒內燒到定色，不然它會變成另一個碼表。
      const heat = Math.min(1, elapsed / HIDE_AFTER);

      const cx = w / 2;
      const cy = h * 0.5;
      const rr = Math.min(w, h) * 0.2;
      const doneShare = ctx.field.actors.size > 0 ? acts.size / ctx.field.actors.size : 0;

      if (d.gesture === "torch") {
        /* 烤箱：玻璃窗的亮度 = 已經按下開燈的人的比例。
           全場的手電筒一起亮的時候，投影幕上的烤箱也跟著亮起來。 */
        const ow = rr * 2.4;
        const oh = rr * 1.8;
        card(g, cx - ow / 2, cy - oh / 2, ow, oh, "#5E6675", unit, "#3A404C");
        const glow = running ? 0.15 + doneShare * 0.85 : 0.1;
        roundRect(g, cx - ow * 0.38, cy - oh * 0.3, ow * 0.76, oh * 0.55, unit * 2);
        const win = g.createRadialGradient(cx, cy, 0, cx, cy, ow * 0.4);
        win.addColorStop(0, `rgba(255,220,120,${glow})`);
        win.addColorStop(1, `rgba(120,60,20,${0.4 + glow * 0.4})`);
        g.fillStyle = win;
        g.fill();
        g.strokeStyle = "#2A2E36";
        g.lineWidth = unit * 0.6;
        g.stroke();
        // 焗烤盤
        g.fillStyle = shade("#F2C94C", -0.3 + glow * 0.3);
        g.beginPath();
        g.ellipse(cx, cy + oh * 0.12, ow * 0.25, oh * 0.08, 0, 0, Math.PI * 2);
        g.fill();
        // 旋鈕
        g.fillStyle = "#C7CCD6";
        for (const k of [-1, 0, 1]) {
          g.beginPath();
          g.arc(cx + k * ow * 0.2, cy + oh * 0.38, unit * 1.3, 0, Math.PI * 2);
          g.fill();
        }
      } else if (d.mode === "soup") {
        // 碗：湯的高度 = 全場平均還剩多少（還沒人交就是滿的）
        let avg = 100;
        if (acts.size > 0) {
          let sum = 0;
          for (const a of acts.values()) sum += a.score;
          avg = sum / acts.size;
        }
        const sway = running ? Math.sin(now / 400) * 0.08 : 0;
        g.save();
        g.translate(cx, cy + rr * 0.3);
        g.rotate(sway);
        g.beginPath();
        g.moveTo(-rr * 1.2, -rr * 0.4);
        g.quadraticCurveTo(-rr * 1.15, rr * 0.9, 0, rr * 0.95);
        g.quadraticCurveTo(rr * 1.15, rr * 0.9, rr * 1.2, -rr * 0.4);
        g.closePath();
        g.fillStyle = "#FFFFFF";
        g.fill();
        g.strokeStyle = "#C9A06A";
        g.lineWidth = unit * 0.8;
        g.stroke();
        // 湯面
        // 滿的時候也留一點碗緣，不然整個碗看起來像是橘色的
        const level = -rr * 0.22 + (1 - avg / 100) * rr * 1.0;
        g.save();
        g.clip();
        g.fillStyle = "#E8A33D";
        g.fillRect(-rr * 1.3, level, rr * 2.6, rr * 2);
        g.restore();
        // 碗口的藍色花紋
        g.strokeStyle = "#2D6CDF";
        g.lineWidth = unit * 0.5;
        g.beginPath();
        g.moveTo(-rr * 1.15, -rr * 0.2);
        g.quadraticCurveTo(0, -rr * 0.05, rr * 1.15, -rr * 0.2);
        g.stroke();
        g.restore();
        // 熱氣
        g.strokeStyle = "rgba(255,255,255,.7)";
        g.lineWidth = unit * 0.5;
        for (const k of [-1, 0, 1]) {
          g.beginPath();
          const sx = cx + k * rr * 0.4;
          g.moveTo(sx, cy - rr * 0.3);
          g.bezierCurveTo(sx + unit * 2, cy - rr * 0.6, sx - unit * 2, cy - rr * 0.8, sx + Math.sin(now / 300 + k) * unit, cy - rr * 1.1);
          g.stroke();
        }
      } else {
        // 爐火：開始之後才燒起來
        if (running) {
          for (let k = 0; k < 7; k++) {
            const fx = cx - rr * 0.8 + (k / 6) * rr * 1.6;
            const fh = rr * (0.25 + 0.12 * Math.sin(now / 90 + k * 1.7));
            const fg = g.createLinearGradient(0, cy + rr * 0.85, 0, cy + rr * 0.85 - fh);
            fg.addColorStop(0, "#FF5A1F");
            fg.addColorStop(1, "rgba(255,210,60,0)");
            g.fillStyle = fg;
            g.beginPath();
            g.moveTo(fx - unit * 1.4, cy + rr * 0.85);
            g.quadraticCurveTo(fx, cy + rr * 0.85 - fh * 1.3, fx + unit * 1.4, cy + rr * 0.85);
            g.fill();
          }
        }
        // 平底鍋：柄＋鍋身
        g.fillStyle = "#3A2A1C";
        roundRect(g, cx + rr * 0.9, cy - unit * 1.2, rr * 1.0, unit * 2.4, unit * 1.2);
        g.fill();
        g.fillStyle = "#2B2B30";
        g.beginPath();
        g.ellipse(cx, cy + rr * 0.1, rr, rr * 0.62, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#44444C";
        g.beginPath();
        g.ellipse(cx, cy + rr * 0.05, rr * 0.88, rr * 0.52, 0, 0, Math.PI * 2);
        g.fill();
        // 鍋裡的菜。顏色隨熱度變深，兩秒內定色，不會變成另一個碼表。
        const food = FOOD[index] ?? "#F2C94C";
        g.fillStyle = shade(food, -heat * 0.25);
        g.beginPath();
        g.ellipse(cx, cy + rr * 0.05, rr * 0.6, rr * 0.34, 0, 0, Math.PI * 2);
        g.fill();
        if (d.gesture === "shake") {
          // 撒胡椒粉：黑點點
          g.fillStyle = "#2A2A2A";
          for (let k = 0; k < 18; k++) {
            g.beginPath();
            g.arc(cx + Math.cos(k * 2.3) * rr * 0.45, cy + Math.sin(k * 1.7) * rr * 0.22, unit * 0.35, 0, Math.PI * 2);
            g.fill();
          }
        }
        if (index === 2) {
          // 掀鍋蓋：蓋子，越多人掀了就抬得越高
          const lift = doneShare * rr * 0.6;
          g.fillStyle = "#C7CCD6";
          g.beginPath();
          g.ellipse(cx, cy - lift, rr * 0.9, rr * 0.35, 0, Math.PI, 0);
          g.fill();
          g.fillStyle = "#8C93A1";
          g.beginPath();
          g.arc(cx, cy - lift - rr * 0.35, unit * 1.5, 0, Math.PI * 2);
          g.fill();
        }
      }

      /* 秒數放在一個對話框裡。前兩秒看得到，之後換成「？」——
         這一關的樂趣就是用身體數秒，把碼表留在畫面上就沒了。 */
      const bubbleX = cx;
      const bubbleY = cy - rr * 1.25;
      card(g, bubbleX - unit * 11, bubbleY - unit * 5.5, unit * 22, unit * 11, "#FFFFFF", unit, "#F2A72C");
      g.textAlign = "center";
      g.textBaseline = "middle";
      if (running && d.mode === "soup") {
        // 端湯不是數秒的題目，是「撐完 20 秒」—— 倒數要一直看得到
        g.fillStyle = "#E07B00";
        g.font = font(unit * 7);
        g.fillText(String(Math.max(0, Math.ceil(d.seconds - elapsed))), bubbleX, bubbleY);
      } else if (running) {
        g.save();
        g.globalAlpha = reveal;
        g.fillStyle = "#E07B00";
        g.font = font(unit * 7);
        g.fillText(elapsed.toFixed(1), bubbleX, bubbleY);
        g.restore();
        if (reveal < 0.15) {
          g.fillStyle = "#E07B00";
          g.font = font(unit * 7);
          g.fillText("？", bubbleX, bubbleY);
        }
      } else {
        g.fillStyle = "#E07B00";
        g.font = font(unit * 6);
        g.fillText(`${d.seconds}秒`, bubbleX, bubbleY);
      }

      // 四隻戴廚師帽的皮克敏站在流理台上
      DISPLAY_ORDER.forEach((id, i) => {
        const side = i < 2 ? -1 : 1;
        const px = cx + side * (rr * 1.9 + (i % 2) * unit * 11);
        pikmin(g, px, counterY + unit * 1, unit * 17, id, {
          t: now, phase: i, chef: true, face: side === -1 ? 1 : -1,
          wave: !running && acts.size > 0 && i === Math.floor(now / 900) % 4,
        });
      });

      g.font = font(unit * 2.8);
      g.fillStyle = "#6B3A10";
      g.textAlign = "center";
      g.fillText(
        d.mode === "soup"
          ? running
            ? `${d.verb}　${acts.size} 人已端到`
            : `撐 ${d.seconds} 秒，${d.verb}`
          : running
            ? `${d.seconds} 秒時${d.verb}　${acts.size} 人已完成`
            : `${d.seconds} 秒時${d.verb}`,
        cx,
        counterY + unit * 5,
      );

      /* 端湯：投影幕上寫全場平均還剩多少湯。
         個別玩家的碗不畫 —— 一百個晃來晃去的碗只會讓人看不到重點，
         而且那些資料留在各自的手機上，本來就不該送上來（規則一）。 */
      if (d.mode === "soup" && acts.size > 0) {
        let sum = 0;
        for (const a of acts.values()) sum += a.score;
        bigText(g, `全場平均還剩 ${Math.round(sum / acts.size)}% 的湯`, cx, counterY + unit * 11, unit * 3.4, "#E07B00");
      }

      // 這一關刻意不畫玩家的圓圈：一百個點飄在鍋子旁邊只會擋住秒數。

      // 前五名，連誤差一起寫出來，現場才吵得起來
      const top = [...ctx.field.actors.entries()]
        .filter(([uid]) => acts.has(uid))
        .sort((a, b) => (acts.get(b[0])?.score ?? 0) - (acts.get(a[0])?.score ?? 0))
        .slice(0, 5);

      if (top.length > 0) {
        const bw = unit * 40;
        const boxH = unit * (7 + top.length * 4);
        const bx = w - bw - unit * 3;
        const by = h - boxH - unit * 3;
        card(g, bx, by, bw, boxH, "#FFFFFF", unit, "#F2A72C");
        bigText(g, d.mode === "soup" ? "湯端最穩的" : "火候最準的", bx + bw / 2, by + unit * 3.5, unit * 2.8, "#E07B00");

        top.forEach(([uid, actor], i) => {
          const f = acts.get(uid);
          if (!f) return;
          const y = by + unit * (8.5 + i * 4);
          g.font = font(unit * 2.3);
          g.textBaseline = "middle";
          g.textAlign = "left";
          g.fillStyle = TEAMS[actor.team].light ? "#3A4A66" : shade(TEAMS[actor.team].color, -0.25);
          g.fillText(actor.name, bx + unit * 2, y);
          g.fillStyle = "#7A6A5A";
          if (d.mode === "soup") {
            g.fillText(`剩 ${f.score}%`, bx + unit * 17, y);
          } else {
            const err = f.ms / 1000 - d.seconds;
            g.fillText(`${err >= 0 ? "+" : ""}${err.toFixed(2)}s`, bx + unit * 17, y);
            // tap 的人標一下，現場才知道有多少支手機的感測器沒作用
            if (f.by === "tap" && d.gesture !== "torch") g.fillText("（按鈕）", bx + unit * 26, y);
          }
          g.textAlign = "right";
          g.fillStyle = "#1E3A7A";
          g.fillText(`${f.score}`, bx + bw - unit * 2, y);
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
        ctx.sfx("start");
      }
      announce(ctx, on ? startHint() : "暫停");
      return true;
    },

    key(e, ctx) {
      // T 走跟主控台同一條路，才不會有兩套開始／暫停的邏輯要對
      if (e.key === "t" || e.key === "T") {
        this.run?.(!running, ctx);
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
