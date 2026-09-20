/* ============================================================
   最後一關：總排行榜

   跟 L 鍵那個覆蓋層不一樣。覆蓋層是主持人中途想看一眼用的，
   這一關是**頒獎**：會從第十名往上一個一個跳出來，最後停在冠軍。

   為什麼要做成一個關卡而不是只留覆蓋層：
   覆蓋層是「蓋在目前這一關上面」，底下還在跑遊戲；頒獎需要一個
   乾淨的、可以停很久讓大家拍照的畫面，而且主持人要能用同一套
   →／T 操作它，不能是一個要記得按的隱藏快捷鍵。

   分數是跨關卡的總分（Actor.total + 這一關的 score），
   跟主控台計分表看到的是同一份。
   ============================================================ */

import { TEAMS, TEAM_IDS, type TeamId } from "../../shared/teams";
import type { Game, GameContext } from "./types";

const SHOW = 10;
/** 每隔多久揭曉下一名 */
const STEP_MS = 900;

export function createFinaleGame(): Game {
  let revealedCount = 0;
  let lastStep = 0;
  let running = false;
  /** 進到這一關時凍結一份名次，之後不再變 —— 頒獎到一半名次跳動很難看 */
  let frozen: { uid: string; name: string; team: TeamId; total: number }[] = [];
  let teamTotals: Record<string, number> = {};

  function snapshot(ctx: GameContext): void {
    frozen = [...ctx.field.actors.entries()]
      .map(([uid, a]) => ({ uid, name: a.name, team: a.team, total: a.total + a.score }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);

    teamTotals = {};
    for (const id of TEAM_IDS) teamTotals[id] = 0;
    for (const r of frozen) teamTotals[r.team] = (teamTotals[r.team] ?? 0) + r.total;
  }

  return {
    id: "finale",
    title: "總排行榜",
    brief: "頒獎。T 開始一個一個揭曉，R 重來。這一關的分數是跨關卡累計的總分。",
    hideQr: true,

    enter(ctx) {
      running = false;
      revealedCount = 0;
      snapshot(ctx);
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

    step(_dt, now) {
      if (!running) return;
      const target = Math.min(SHOW, frozen.length);
      if (revealedCount >= target) {
        running = false;
        return;
      }
      if (now - lastStep >= STEP_MS) {
        lastStep = now;
        revealedCount++;
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;

      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "#F2A72C";
      g.font = `900 ${Math.round(unit * 7)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText("總排行榜", w / 2, unit * 8);

      if (frozen.length === 0) {
        g.fillStyle = "rgba(255,255,255,.5)";
        g.font = `700 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText("還沒有人得分", w / 2, h / 2);
        return;
      }

      const shown = frozen.slice(0, Math.min(SHOW, frozen.length));
      const top = shown[0]?.total || 1;

      // 從最後一名往上揭曉：已揭曉的是排名尾端那幾個
      const firstVisible = shown.length - revealedCount;

      shown.forEach((r, i) => {
        if (i < firstVisible) return;
        const y = unit * 18 + i * unit * 6.4;
        const barW = w * 0.42 * (r.total / top);
        const fresh = i === firstVisible;

        g.textAlign = "right";
        g.fillStyle = i === 0 ? "#F2A72C" : "rgba(255,255,255,.5)";
        g.font = `900 ${Math.round(unit * 3.4)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(`${i + 1}`, w * 0.2, y);

        g.textAlign = "left";
        g.fillStyle = "#FFFFFF";
        // 剛跳出來的那一名閃一下，眼睛才知道要看哪裡
        g.globalAlpha = fresh ? 0.6 + 0.4 * Math.sin(now / 90) : 1;
        g.fillText(r.name, w * 0.22, y);
        g.globalAlpha = 1;

        g.fillStyle = TEAMS[r.team].color;
        g.fillRect(w * 0.42, y - unit * 1.5, barW, unit * 3);

        g.fillStyle = "#FFFFFF";
        g.font = `900 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(`${r.total}`, w * 0.42 + barW + unit * 1.5, y);
      });

      // 隊伍總分，放在最下面。個人第一名不一定在冠軍隊，兩個都要有。
      const teamY = h - unit * 6;
      const teamTop = Math.max(1, ...TEAM_IDS.map((id) => teamTotals[id] ?? 0));
      g.textAlign = "center";
      TEAM_IDS.forEach((id, i) => {
        const cx = (w / 4) * i + w / 8;
        const t = teamTotals[id] ?? 0;
        g.fillStyle = TEAMS[id].color;
        g.font = `900 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(TEAMS[id].name, cx, teamY);
        g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillStyle = t >= teamTop && t > 0 ? "#F2A72C" : "#FFFFFF";
        g.fillText(String(t), cx, teamY + unit * 5);
      });

      if (revealedCount === 0) {
        g.fillStyle = "rgba(255,255,255,.65)";
        g.font = `700 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText("按 T 開始揭曉", w / 2, h * 0.5);
      }
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (revealedCount === 0) snapshot(ctx); // 開始前再抓一次最新的
        running = true;
        lastStep = 0;
        return true;
      }
      if (e.key === "r" || e.key === "R") {
        running = false;
        revealedCount = 0;
        snapshot(ctx);
        return true;
      }
      return false;
    },
  };
}
