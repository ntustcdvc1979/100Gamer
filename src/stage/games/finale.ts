/* ============================================================
   最後一關：總排行榜

   跟 L 鍵那個覆蓋層不一樣。覆蓋層是主持人中途想看一眼用的，
   這一關是**頒獎**：四個隊伍從第四名往上一個一個揭曉，最後停在冠軍。

   只排隊伍，不排個人。
   這是四象星座的團體活動，頒獎台上站的是「火象、土象、水象、風象」，
   不是某一個人 —— 投影幕上列出個人前十名，只會讓沒上榜的九十個人覺得
   「跟我沒關係」。個人分數主持人在主控台的計分表還看得到。

   為什麼要做成一個關卡而不是只留覆蓋層：
   覆蓋層是「蓋在目前這一關上面」，底下還在跑遊戲；頒獎需要一個
   乾淨的、可以停很久讓大家拍照的畫面，而且主持人要能用同一套
   →／T 操作它，不能是一個要記得按的隱藏快捷鍵。

   分數是跨關卡的總分（Actor.total + 這一關的 score）的隊伍加總。
   ============================================================ */

import { TEAMS, TEAM_IDS, type TeamId } from "../../shared/teams";
import { bigText, createConfetti, flushPikmin, font, pikmin, scenery, shade } from "../cartoon";
import type { Game, GameContext } from "./types";

/** 每隔多久揭曉下一隊 */
const STEP_MS = 1600;
/** 柱子從地面升到定位要多久 */
const RISE_MS = 900;

export function createFinaleGame(): Game {
  /** 已經揭曉了幾隊（從最後一名開始算） */
  let revealedCount = 0;
  let lastStep = 0;
  let running = false;
  /** 進到這一關時凍結一份名次，之後不再變 —— 頒獎到一半名次跳動很難看 */
  let ranked: TeamId[] = [];
  let teamTotals: Record<string, number> = {};
  /** 每一隊（照名次）是什麼時候揭曉的，柱子要從那一刻開始往上長 */
  const revealedAt: number[] = [];
  const confetti = createConfetti();
  let lastDraw = 0;
  /** 冠軍揭曉過了沒（放一次號角就好） */
  let crowned = false;

  function snapshot(ctx: GameContext): void {
    teamTotals = {};
    for (const id of TEAM_IDS) teamTotals[id] = 0;
    for (const a of ctx.field.actors.values()) {
      teamTotals[a.team] = (teamTotals[a.team] ?? 0) + a.total + a.score;
    }
    ranked = [...TEAM_IDS].sort((a, b) => (teamTotals[b] ?? 0) - (teamTotals[a] ?? 0));
  }

  function reset(ctx: GameContext): void {
    running = false;
    revealedCount = 0;
    revealedAt.length = 0;
    crowned = false;
    confetti.clear();
    snapshot(ctx);
  }

  return {
    id: "finale",
    title: "總排行榜",
    brief: "頒獎。T 開始從第四名往上一隊一隊揭曉，R 重來。分數是各隊跨關卡累計的總分。",
    hideQr: true,
    cartoon: true,
    bgm: "award",

    enter(ctx) {
      reset(ctx);
      ctx.publish({
        phase: "result",
        game: "finale",
        round: 1,
        control: undefined,
        accepting: false,
        hint: "看投影幕 🏆",
        options: [],
      });
    },

    step(_dt, now, ctx) {
      if (!running) return;
      if (revealedCount >= ranked.length) {
        running = false;
        return;
      }
      if (now - lastStep >= STEP_MS) {
        lastStep = now;
        revealedCount++;
        // 揭曉的是名次 ranked.length - revealedCount（第四名、第三名…）
        revealedAt[ranked.length - revealedCount] = now;
        if (revealedCount >= ranked.length && !crowned) {
          // 冠軍跳出來：號角、歡呼、彩帶
          crowned = true;
          ctx.sfx("fanfare");
          setTimeout(() => ctx.sfx("cheer"), 600);
          confetti.burst(0.5, 0.25, 260, now);
        } else {
          ctx.sfx("pop");
        }
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const dt = Math.min(0.1, (now - lastDraw) / 1000);
      lastDraw = now;
      scenery(g, w, h, now, "meadow", 0.72);

      bigText(g, "總排行榜", w / 2, unit * 8, unit * 7, "#E07B00");

      /* ---- 四隊的頒獎台 ----
         用高度而不是左右的長條。四根柱子站在同一條地面上，
         誰高誰矮不用讀數字就看得出來 —— 這是頒獎那一刻要的效果。
         排法照真的頒獎台：第二名在左、第一名在中間偏左、第三名在右、第四名最右。
         柱子最高拉到畫面快一半，站在上面的皮克敏和分數才不會擠在一起。 */
      const ground = h - unit * 5;
      const teamTop = Math.max(1, ...TEAM_IDS.map((id) => teamTotals[id] ?? 0));
      /** 名次 → 左右位置 */
      const order = [1, 0, 2, 3];
      /** 柱子最高可以多高。上面還要留皮克敏、分數和隊名的位置。 */
      const maxBar = h * 0.46;
      const cw = w * 0.16;
      const gap = unit * 3.5;

      g.textAlign = "center";
      order.forEach((rank, slot) => {
        const id = ranked[rank];
        if (!id) return;
        const t = teamTotals[id] ?? 0;
        const cx = w / 2 + (slot - 1.5) * (cw + gap);
        const bx = cx - cw / 2;
        const shown = revealedAt[rank] !== undefined;
        // 還沒揭曉的：只留一塊矮矮的台座和一個問號
        const rise = shown ? easeOut(Math.min(1, (now - (revealedAt[rank] ?? now)) / RISE_MS)) : 0;
        const full = Math.max(unit * 5, maxBar * (t / teamTop));
        const bh = unit * 3 + (full - unit * 3) * rise;
        const first = rank === 0 && t > 0 && crowned;

        // 柱子：左亮右暗的漸層＋頂面一條亮邊，看起來是有體積的台子，不是一張色塊
        const colGrad = g.createLinearGradient(bx, 0, bx + cw, 0);
        if (shown) {
          colGrad.addColorStop(0, TEAMS[id].light ? "#FFFFFF" : shade(TEAMS[id].color, 0.25));
          colGrad.addColorStop(1, TEAMS[id].light ? "#D5DCE8" : shade(TEAMS[id].color, -0.2));
        } else {
          colGrad.addColorStop(0, "#C9CFD9");
          colGrad.addColorStop(1, "#A8B0BE");
        }
        g.save();
        g.shadowColor = "rgba(0,0,0,.3)";
        g.shadowBlur = unit * 2;
        g.fillStyle = colGrad;
        g.fillRect(bx, ground - bh, cw, bh);
        g.restore();
        g.fillStyle = "rgba(255,255,255,.45)";
        g.fillRect(bx, ground - bh, cw, Math.min(bh, unit * 0.9));
        // 風象是白的，柱子邊要加一圈深色，不然會跟背景糊掉
        if (shown && TEAMS[id].light) {
          g.strokeStyle = "rgba(0,0,0,.45)";
          g.lineWidth = Math.max(2, unit * 0.3);
          g.strokeRect(bx, ground - bh, cw, bh);
        }

        if (!shown) {
          bigText(g, "？", cx, ground - bh - unit * 5, unit * 6, "#6B7488");
          return;
        }

        // 柱子上站兩隻這隊的皮克敏，分數和隊名寫在頭上
        const pikH = unit * 14;
        pikmin(g, cx - cw * 0.2, ground - bh, pikH, id, { t: now, phase: rank * 2, wave: first, face: 1 });
        pikmin(g, cx + cw * 0.2, ground - bh, pikH, id, { t: now, phase: rank * 2 + 1, wave: first, face: -1 });
        const labelBase = ground - bh - pikH - unit * 1.5;

        // 分數跟著柱子一起數上去
        g.textBaseline = "bottom";
        g.fillStyle = first ? "#E07B00" : "#1E3A7A";
        g.font = font(unit * 4.4);
        g.fillText(String(Math.round(t * rise)), cx, labelBase - unit * 4.4);
        // 白色、黃色的字直接寫在天空上看不清楚，用描邊字、顏色壓深一點
        bigText(
          g, `${TEAMS[id].name}・${TEAMS[id].pikmin}`, cx, labelBase - unit * 1.8, unit * 2.8,
          TEAMS[id].light ? "#3A4A66" : shade(TEAMS[id].color, -0.2),
        );

        // 柱子上寫名次，站上去的感覺才出得來
        if (bh > unit * 9) {
          g.textBaseline = "middle";
          g.fillStyle = TEAMS[id].ink;
          g.font = font(unit * 7);
          g.fillText(String(rank + 1), cx, ground - bh + unit * 6);
        }
      });

      flushPikmin(g);
      confetti.draw(g, w, h, now, dt);

      if (revealedCount === 0) {
        bigText(g, "準備頒獎", w / 2, h * 0.3, unit * 4, "#1E4FB8");
      } else if (crowned) {
        const champ = ranked[0];
        if (champ) bigText(g, `冠軍：${TEAMS[champ].name}星座！`, w / 2, unit * 16, unit * 4.2, "#E07B00");
      }
    },

    running: () => running,

    run(on, ctx) {
      if (running === on) return true;
      if (on) {
        if (revealedCount === 0) snapshot(ctx); // 開始前再抓一次最新的
        running = true;
        lastStep = 0;
      } else {
        // 暫停是頒獎時最常用的功能：停在某一名讓大家拍照
        running = false;
      }
      return true;
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (revealedCount === 0) snapshot(ctx); // 開始前再抓一次最新的
        running = true;
        lastStep = 0;
        return true;
      }
      if (e.key === "r" || e.key === "R") {
        reset(ctx);
        return true;
      }
      return false;
    },
  };
}

function easeOut(x: number): number {
  return 1 - (1 - x) ** 3;
}
