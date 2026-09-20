/* ============================================================
   遊戲二：四方拔河（分組對抗・主軸）

   大球在正中間，四隊分別往上下左右自己的顏色區推。
   先把球推進自己那一區的隊伍得一分，三戰兩勝。

   兩個關鍵設計：

   1. 隊伍推力用「平均」不是「總和」。
      分隊是照座位號輪流發的，理論上平均，但現場一定會有人中途離線、
      有人手機沒電。用總和的話人多的隊直接贏，比賽就沒意義了。

   2. 畫面上要顯示「參與率」。
      這一關真正好玩的地方不是體力，是看到自己隊上有 8 個人在放空。
      那個數字會讓全隊自己吼起來 —— 社交壓力就是這個遊戲的引擎。

   延遲容忍度：極高。球的位置是推力的積分，單次輸入早到晚到 100ms
   完全看不出來。這就是為什麼它適合當主軸。
   ============================================================ */

import { TEAMS, TEAM_IDS, type TeamId } from "../../shared/teams";
import type { Game, GameContext } from "./types";

/** 每一隊的球門方向（畫面座標，y 往下是正） */
const GOAL: Record<TeamId, { x: number; y: number; label: string }> = {
  A: { x: -1, y: 0, label: "左" },
  B: { x: 0, y: -1, label: "上" },
  C: { x: 1, y: 0, label: "右" },
  D: { x: 0, y: 1, label: "下" },
};

/** 球被推動的加速度（每秒每秒幾個畫面寬） */
const FORCE = 0.55;
/** 阻尼。沒有的話球會一直滑，永遠停不下來。 */
const DRAG = 1.6;
/** 推進這個距離就算進球 */
const GOAL_LINE = 0.12;
const WIN_ROUNDS = 2;

export function createTugOfWarGame(): Game {
  let ball = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
  let running = false;
  let round = 1;
  const wins: Record<string, number> = {};
  let winner: TeamId | null = null;
  let winAt = 0;
  let push = {} as ReturnType<GameContext["field"]["teamPush"]>;

  function resetBall(): void {
    ball = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
  }

  function publishScores(ctx: GameContext, hint: string): void {
    const teams: Record<string, { score: number }> = {};
    for (const id of TEAM_IDS) teams[id] = { score: wins[id] ?? 0 };
    ctx.publish({ phase: "playing", game: "tugofwar",
      control: "joystick", round, teams, hint, options: [] });
  }

  return {
    id: "tugofwar",
    title: "四方拔河",
    brief: "四隊把球推進自己的顏色區。T 開始／暫停，R 重新開球。三戰兩勝。",

    enter(ctx) {
      round = 1;
      winner = null;
      running = false;
      for (const id of TEAM_IDS) wins[id] = 0;
      resetBall();
      // 位置不打散：這一關人不會動，站哪裡不重要
      ctx.field.reset(false);
      publishScores(ctx, "看投影幕，往你的顏色方向用力推！");
    },

    step(dt, now, ctx) {
      push = ctx.field.teamPush(now);

      if (!running || winner) return;

      // 每一隊的平均搖桿，投影到自己球門的方向。
      // 往別的方向亂推不會扣分，但也完全沒有用 —— 這就是要協調的地方。
      let ax = 0;
      let ay = 0;
      for (const id of TEAM_IDS) {
        const p = push[id];
        const g = GOAL[id];
        if (!p || p.active === 0) continue;
        const along = p.x * g.x + p.y * g.y;
        if (along <= 0) continue;
        ax += g.x * along * FORCE;
        ay += g.y * along * FORCE;
      }

      ball.vx = (ball.vx + ax * dt) * Math.max(0, 1 - DRAG * dt);
      ball.vy = (ball.vy + ay * dt) * Math.max(0, 1 - DRAG * dt);
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      ball.x = Math.min(1, Math.max(0, ball.x));
      ball.y = Math.min(1, Math.max(0, ball.y));

      const scored =
        ball.x < GOAL_LINE ? "A"
        : ball.y < GOAL_LINE ? "B"
        : ball.x > 1 - GOAL_LINE ? "C"
        : ball.y > 1 - GOAL_LINE ? "D"
        : null;

      if (scored) {
        wins[scored] = (wins[scored] ?? 0) + 1;
        running = false;
        resetBall();
        if ((wins[scored] ?? 0) >= WIN_ROUNDS) {
          winner = scored as TeamId;
          winAt = now;
          publishScores(ctx, `${TEAMS[winner].name}獲勝！🏆`);
        } else {
          round++;
          publishScores(ctx, `${TEAMS[scored as TeamId].name}得分！等主持人開下一局`);
        }
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;

      // 四個角落的球門區
      for (const id of TEAM_IDS) {
        const goal = GOAL[id];
        g.save();
        g.globalAlpha = 0.16;
        g.fillStyle = TEAMS[id].color;
        if (goal.x === -1) g.fillRect(0, 0, w * GOAL_LINE, h);
        else if (goal.x === 1) g.fillRect(w * (1 - GOAL_LINE), 0, w * GOAL_LINE, h);
        else if (goal.y === -1) g.fillRect(0, 0, w, h * GOAL_LINE);
        else g.fillRect(0, h * (1 - GOAL_LINE), w, h * GOAL_LINE);
        g.restore();
      }

      ctx.field.drawActors(ctx.surface, now, { radius: unit * 1.1, names: false });

      // 球
      const br = unit * 6;
      const grad = g.createRadialGradient(
        ball.x * w - br * 0.3, ball.y * h - br * 0.3, br * 0.2,
        ball.x * w, ball.y * h, br,
      );
      grad.addColorStop(0, "#FFFFFF");
      grad.addColorStop(1, "#C9C2AE");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(ball.x * w, ball.y * h, br, 0, Math.PI * 2);
      g.fill();

      // 各隊的推力條與參與率，沿著畫面底部排成四欄。
      // 放左上角會跟 HUD（房號、人數、關卡名）疊在一起，後排就全糊了。
      const stripH = unit * 11;
      const stripY = h - stripH;
      g.fillStyle = "rgba(10,10,14,.72)";
      g.fillRect(0, stripY, w, stripH);

      const colW = w / 4;
      g.textBaseline = "middle";
      TEAM_IDS.forEach((id, i) => {
        const p = push[id];
        const team = TEAMS[id];
        const cx = colW * i + colW / 2;
        const along = p ? Math.max(0, p.x * GOAL[id].x + p.y * GOAL[id].y) : 0;

        g.textAlign = "center";
        g.fillStyle = team.color;
        g.font = `900 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(`${team.name}（往${GOAL[id].label}） ${wins[id] ?? 0}`, cx, stripY + unit * 2.6);

        const barW = colW * 0.72;
        g.fillStyle = "rgba(255,255,255,.14)";
        g.fillRect(cx - barW / 2, stripY + unit * 4.8, barW, unit * 2.2);
        g.fillStyle = team.color;
        g.fillRect(cx - barW / 2, stripY + unit * 4.8, barW * along, unit * 2.2);

        // 參與率。這個數字是這一關的靈魂 ——
        // 看到自己隊上有八個人在放空，整隊自己就吼起來了。
        g.fillStyle = "rgba(255,255,255,.8)";
        g.font = `700 ${Math.round(unit * 2.2)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(`${p?.active ?? 0} / ${p?.size ?? 0} 人在推`, cx, stripY + unit * 9);
      });

      g.textAlign = "center";
      g.fillStyle = "#FFFFFF";
      if (winner) {
        g.globalAlpha = 0.7 + 0.3 * Math.sin((now - winAt) / 150);
        g.font = `900 ${Math.round(unit * 9)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(`${TEAMS[winner].name} 獲勝`, w / 2, h / 2);
        g.globalAlpha = 1;
      } else if (!running) {
        g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(`第 ${round} 局`, w / 2, stripY - unit * 4);
      }
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (winner) return true;
        running = !running;
        publishScores(ctx, running ? "推！往你的顏色方向！" : "暫停");
        return true;
      }
      if (e.key === "r" || e.key === "R") {
        running = false;
        resetBall();
        publishScores(ctx, "重新開球，等主持人喊開始");
        return true;
      }
      return false;
    },
  };
}
