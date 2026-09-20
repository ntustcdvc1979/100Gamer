/* ============================================================
   遊戲：文字找不同（個人賽）

   滿滿一片「人」裡面藏一個「入」，玩家要在自己手機上點出那一格。
   越快點到分數越高，點錯就沒分。

   為什麼字陣長在手機上而不只在投影幕上：

   如果只有投影幕有，玩家找到之後還要把「螢幕上的位置」對應回
   自己手機上的某一格 —— 百人場那是酷刑。所以兩邊都畫同一張表，
   投影幕負責讓全場有共同的畫面與緊張感，手機負責讓人點得到。

   兩邊怎麼長出同一張表：state 裡帶一個亂數種子，
   投影幕和手機用同一個 PRNG 算出一樣的位置。

   ⚠️ 這代表答案在手機的記憶體裡。開 devtools 的人可以直接看到，
   但那是派對遊戲可以接受的程度 —— 要真的防就得每一格都走伺服器，
   不值得為這個加一條通道。
   ============================================================ */

import type { Game, GameContext } from "./types";

interface Puzzle {
  /** 一般的字 */
  normal: string;
  /** 藏起來的那個字 */
  odd: string;
  rows: number;
  cols: number;
}

/** 由易到難。行列數越大越難找。 */
const PUZZLES: Puzzle[] = [
  { normal: "人", odd: "入", rows: 6, cols: 8 },
  { normal: "己", odd: "已", rows: 8, cols: 10 },
  { normal: "末", odd: "未", rows: 10, cols: 12 },
];

const ROUND_MS = 30_000;

/**
 * 種子亂數。
 *
 * 一定要自己寫一個，不能用 Math.random() ——
 * 投影幕和一百支手機要算出同一張表，就必須是同一個可重現的序列。
 */
export function seededIndex(seed: number, count: number): number {
  let x = seed >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5;
  x >>>= 0;
  return x % count;
}

export function createFindCharGame(): Game {
  let index = 0;
  let seed = 1;
  let oddAt = 0;
  let running = false;
  let revealed = false;
  let startedAt = 0;
  let endsAt = 0;
  /** 誰在第幾毫秒點到、點對了沒 */
  const tries = new Map<string, { i: number; ms: number; ok: boolean }>();

  function p(): Puzzle {
    return PUZZLES[index] as Puzzle;
  }

  function announce(ctx: GameContext, hint: string): void {
    ctx.publish({
      phase: "playing",
      game: "findchar",
      round: index + 1,
      control: "find",
      accepting: running,
      revealed,
      seed,
      rows: p().rows,
      cols: p().cols,
      // 兩個字放在 options 裡，手機才知道要畫什麼
      options: [p().normal, p().odd],
      hint,
    });
  }

  function load(ctx: GameContext): void {
    running = false;
    revealed = false;
    tries.clear();
    seed = (Math.floor(Math.random() * 0xffffff) + 1) >>> 0;
    oddAt = seededIndex(seed, p().rows * p().cols);
    ctx.field.reset(false);
    announce(ctx, `第 ${index + 1} 題：找出不一樣的「${p().odd}」，等主持人開始`);
  }

  function finish(ctx: GameContext): void {
    running = false;
    revealed = true;
    const ok = [...tries.values()].filter((t) => t.ok).length;
    announce(ctx, `答案公布！${ok} 個人找到了`);
  }

  return {
    id: "findchar",
    title: "文字找不同",
    brief: "個人賽。T 開始 30 秒，越快點到分數越高，點錯沒分。→ 換下一題。",

    enter(ctx) {
      index = 0;
      load(ctx);
    },

    step(_dt, now, ctx) {
      if (running && now >= endsAt) finish(ctx);
    },

    action(uid, a, ctx) {
      if (a.k !== "find" || !running) return;
      // 一人一次。不然就變成從頭點到尾一定找得到。
      if (tries.has(uid)) return;
      const actor = ctx.field.actors.get(uid);
      if (!actor) return;

      const ok = a.i === oddAt;
      tries.set(uid, { i: a.i, ms: a.ms, ok });
      if (ok) {
        // 越快越高分：5 秒內接近滿分，30 秒歸零
        const sec = a.ms / 1000;
        actor.score += Math.max(10, Math.round(100 * (1 - sec / ROUND_MS * 1000 / 30)));
        actor.flag = true;
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const { rows, cols, normal, odd } = p();

      const gridH = h * 0.74;
      const gridY = h * 0.13;
      const cellW = w / cols;
      const cellH = gridH / rows;
      const size = Math.min(cellW, cellH) * 0.78;

      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `700 ${Math.round(size)}px "Noto Sans TC", system-ui, sans-serif`;

      for (let i = 0; i < rows * cols; i++) {
        const cx = (i % cols) * cellW + cellW / 2;
        const cy = gridY + Math.floor(i / cols) * cellH + cellH / 2;
        const isOdd = i === oddAt;

        // 公布之前不標記，不然投影幕直接洩題
        if (revealed && isOdd) {
          g.fillStyle = "#F2A72C";
          g.beginPath();
          g.arc(cx, cy, size * 0.75, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "#14141A";
        } else {
          g.fillStyle = "rgba(255,255,255,.88)";
        }
        g.fillText(isOdd ? odd : normal, cx, cy);
      }

      // 抬頭
      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
      const found = [...tries.values()].filter((t) => t.ok).length;
      const left = running ? Math.ceil((endsAt - now) / 1000) : 0;
      g.fillText(
        revealed
          ? `${found} 個人找到了`
          : running
            ? `${left} 秒　已有 ${found} 人找到`
            : `找出不一樣的字`,
        w / 2,
        unit * 6,
      );

      // 最快的前五名
      if (revealed) {
        const top = [...tries.entries()]
          .filter(([, t]) => t.ok)
          .sort((a, b) => a[1].ms - b[1].ms)
          .slice(0, 5);
        g.font = `700 ${Math.round(unit * 2.6)}px system-ui, "Noto Sans TC", sans-serif`;
        g.textAlign = "center";
        top.forEach(([uid, t], i) => {
          const a = ctx.field.actors.get(uid);
          g.fillStyle = i === 0 ? "#F2A72C" : "rgba(255,255,255,.8)";
          g.fillText(
            `${i + 1}. ${a?.name ?? ""}　${(t.ms / 1000).toFixed(2)}s`,
            w / 2 - unit * 30 + i * unit * 15,
            h - unit * 4,
          );
        });
      }
      void startedAt;
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (revealed) return true;
        if (running) {
          finish(ctx);
          return true;
        }
        running = true;
        startedAt = performance.now();
        endsAt = startedAt + ROUND_MS;
        announce(ctx, `找出「${p().odd}」！`);
        return true;
      }
      if (e.key === "ArrowRight" && index < PUZZLES.length - 1) {
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
