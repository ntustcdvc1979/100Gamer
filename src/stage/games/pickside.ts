/* ============================================================
   遊戲三：選邊站（個人賽・收尾）

   投影幕出題，畫面切成四個象限，每個象限一個選項。
   所有人把自己的光點移到自己的選擇 —— 100 個點同時大遷徙，
   這個畫面本身就是這一關最好看的地方。

   兩種題型（見 config/questions.ts）：
     有標準答案 → 答對得分
     沒有答案   → 選的人最少的那一區得分（少數派）

   為什麼選項要放進 state：大禮堂後排根本看不清楚投影幕。
   四段短字約 100 bytes，而且只有換題目時才變，值得。
   這是整個專案唯一一個「明知會變大還是放進 state」的欄位。

   延遲容忍度：高。只看倒數結束那一刻人在哪個象限，
   中間怎麼走、晚到 100ms 都無所謂。
   ============================================================ */

import { QUESTIONS } from "../../config/questions";
import type { Game, GameContext } from "./types";

const COUNTDOWN_MS = 10_000;
const QUAD_COLORS = ["#E4572E", "#F2A72C", "#5C9E31", "#2E6FA7"];

type Stage = "idle" | "counting" | "revealed";

/** 0 左上　1 右上　2 左下　3 右下 */
function quadrantOf(x: number, y: number): number {
  return (y < 0.5 ? 0 : 2) + (x < 0.5 ? 0 : 1);
}

export function createPickSideGame(): Game {
  let index = 0;
  let stage: Stage = "idle";
  let endsAt = 0;
  let counts = [0, 0, 0, 0];
  let winningQuad = -1;

  function q() {
    return QUESTIONS[index] as (typeof QUESTIONS)[number];
  }

  function announce(ctx: GameContext, hint: string): void {
    ctx.publish({
      phase: "playing",
      game: "pickside",
      control: "joystick",
      round: index + 1,
      hint,
      options: [...q().options],
    });
  }

  function load(ctx: GameContext): void {
    stage = "idle";
    winningQuad = -1;
    counts = [0, 0, 0, 0];
    for (const a of ctx.field.actors.values()) a.flag = false;
    announce(ctx, `第 ${index + 1} 題：${q().text}`);
  }

  function reveal(ctx: GameContext): void {
    stage = "revealed";
    counts = [0, 0, 0, 0];
    for (const a of ctx.field.actors.values()) {
      const quad = quadrantOf(a.x, a.y);
      counts[quad] = (counts[quad] ?? 0) + 1;
    }

    const question = q();
    if (question.answer !== undefined) {
      winningQuad = question.answer;
    } else {
      // 少數派得分。沒有人選的區不算 —— 不然永遠是空白區贏。
      let best = -1;
      let bestN = Infinity;
      for (let i = 0; i < 4; i++) {
        const n = counts[i] ?? 0;
        if (n > 0 && n < bestN) {
          bestN = n;
          best = i;
        }
      }
      winningQuad = best;
    }

    for (const a of ctx.field.actors.values()) {
      a.flag = quadrantOf(a.x, a.y) === winningQuad;
      if (a.flag) a.score++;
    }

    const label = winningQuad >= 0 ? question.options[winningQuad] : "沒有人得分";
    announce(ctx, `答案：${label}　（${counts[winningQuad] ?? 0} 人得分）`);
  }

  return {
    id: "pickside",
    title: "選邊站",
    brief: "個人賽。出題後按 T 開始 10 秒倒數，時間到自動公布。→ 換下一題。",

    enter(ctx) {
      index = 0;
      ctx.field.reset();
      load(ctx);
    },

    step(dt, now, ctx) {
      ctx.field.stepActors(dt, 0.5);

      if (stage !== "counting") return;
      if (now >= endsAt) {
        reveal(ctx);
        return;
      }
      // 倒數中即時統計，讓大家看到人潮往哪邊跑
      counts = [0, 0, 0, 0];
      for (const a of ctx.field.actors.values()) {
        const quad = quadrantOf(a.x, a.y);
        counts[quad] = (counts[quad] ?? 0) + 1;
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const question = q();

      // 四個象限
      for (let i = 0; i < 4; i++) {
        const qx = (i % 2) * (w / 2);
        const qy = Math.floor(i / 2) * (h / 2);
        const isWinner = stage === "revealed" && i === winningQuad;

        g.save();
        g.globalAlpha = isWinner ? 0.34 : 0.12;
        g.fillStyle = QUAD_COLORS[i] as string;
        g.fillRect(qx, qy, w / 2, h / 2);
        g.restore();

        g.strokeStyle = "rgba(255,255,255,.18)";
        g.lineWidth = 2;
        g.strokeRect(qx, qy, w / 2, h / 2);

        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillStyle = "#FFFFFF";
        g.globalAlpha = isWinner ? 1 : 0.85;
        g.font = `900 ${Math.round(unit * 4.5)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(question.options[i] as string, qx + w / 4, qy + h / 4 - unit * 2);
        g.font = `700 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(`${counts[i] ?? 0} 人`, qx + w / 4, qy + h / 4 + unit * 3);
        g.globalAlpha = 1;
      }

      ctx.field.drawActors(ctx.surface, now, { radius: unit * 1.2, names: false });

      // 題目橫幅
      const bannerH = unit * 9;
      g.fillStyle = "rgba(20,20,26,.88)";
      g.fillRect(0, h / 2 - bannerH / 2, w, bannerH);
      g.fillStyle = "#FFFFFF";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(question.text, w / 2, h / 2 - unit * 1);

      g.font = `700 ${Math.round(unit * 2.2)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillStyle = "#F2A72C";
      const sub =
        stage === "counting" ? `${Math.ceil((endsAt - now) / 1000)}`
        : stage === "revealed" ? (question.answer !== undefined ? "標準答案" : "少數派得分")
        : "準備中";
      g.fillText(sub, w / 2, h / 2 + unit * 2.8);

      // 個人排行榜
      const top = [...ctx.field.actors.values()]
        .filter((a) => a.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      if (top.length > 0) {
        g.textAlign = "left";
        g.textBaseline = "top";
        g.font = `900 ${Math.round(unit * 2)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillStyle = "rgba(255,255,255,.9)";
        g.fillText("目前領先", unit * 3, h - unit * 18);
        g.font = `700 ${Math.round(unit * 2)}px system-ui, "Noto Sans TC", sans-serif`;
        top.forEach((a, i) => {
          g.fillText(`${i + 1}. ${a.name}　${a.score}`, unit * 3, h - unit * (14.5 - i * 2.6));
        });
      }
    },

    running: () => stage === "counting",

    /* 沒有暫停：倒數一旦開始，全場正在走位，停下來沒有意義。 */
    run(on, ctx) {
      if (!on) return false;
      if (stage !== "idle") return true;
      stage = "counting";
      endsAt = performance.now() + COUNTDOWN_MS;
      announce(ctx, `${q().text}　快選！`);
      return true;
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (stage === "idle") {
          stage = "counting";
          endsAt = performance.now() + COUNTDOWN_MS;
          announce(ctx, `${q().text}　快選！`);
        } else if (stage === "counting") {
          reveal(ctx);   // 主持人想提早公布
        }
        return true;
      }
      if (e.key === "ArrowRight" && index < QUESTIONS.length - 1) {
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
