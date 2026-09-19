/* ============================================================
   遊戲一：聚沙成塔（全體協作・暖身）

   投影幕上有一個鏤空的字，所有人把自己的光點推進去，填滿就成功。
   沒有輸家、沒有計分，目的是讓 100 個人在 30 秒內學會怎麼用搖桿，
   順便讓全場看到「我們真的都在線上」。

   形狀怎麼來的：拿一塊離屏畫布把字畫出來，讀 alpha 通道當遮罩，
   之後只要問「這個點的 alpha 大不大」就知道在不在字裡面。
   好處是換形狀只要換一個字串，不用畫路徑、不用作圖。
   ============================================================ */

import type { Game, GameContext } from "./types";

/** 依序要拼的字。按 → 換下一個。 */
const SHAPES = ["崇德", "100", "♥"];

/** 有這個比例的人進到字裡面就算成功 */
const WIN_RATIO = 0.8;

/** 遮罩的解析度。夠用就好，這只是拿來做點測試。 */
const MASK_W = 240;
const MASK_H = 135;

interface Shape {
  /** 點測試用的 0/1 陣列 */
  mask: Uint8Array<ArrayBufferLike>;
  /** 畫的時候直接把這塊縮放貼上去 */
  canvas: HTMLCanvasElement;
}

function buildShape(text: string): Shape {
  const c = document.createElement("canvas");
  c.width = MASK_W;
  c.height = MASK_H;
  const g = c.getContext("2d");
  if (!g) return { mask: new Uint8Array(MASK_W * MASK_H), canvas: c };

  g.clearRect(0, 0, MASK_W, MASK_H);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";

  // 先用一個基準字級量出實際寬度，再等比放大到填滿畫面，
  // 這樣「崇德」（兩個字）和「100」（三個字）都會撐到差不多大。
  const base = 100;
  g.font = `900 ${base}px system-ui, "Noto Sans TC", sans-serif`;
  const m = g.measureText(text);
  const scale = Math.min((MASK_W * 0.86) / m.width, (MASK_H * 0.8) / base);
  g.font = `900 ${Math.round(base * scale)}px system-ui, "Noto Sans TC", sans-serif`;
  g.fillText(text, MASK_W / 2, MASK_H / 2);

  const data = g.getImageData(0, 0, MASK_W, MASK_H).data;
  const mask = new Uint8Array(MASK_W * MASK_H);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = (data[i * 4 + 3] ?? 0) > 128 ? 1 : 0;
  }
  return { mask, canvas: c };
}

export function createGatherGame(): Game {
  let shapeIndex = 0;
  let shape: Shape = buildShape("");
  let inside = 0;
  let total = 0;
  let won = false;
  let wonAt = 0;

  function load(ctx: GameContext): void {
    shape = buildShape(SHAPES[shapeIndex] as string);
    won = false;
    wonAt = 0;
    ctx.field.reset();
    ctx.publish({
      phase: "playing",
      game: "gather",
      round: shapeIndex + 1,
      hint: "把自己推進投影幕上的字裡面！",
      options: [],
    });
  }

  function hit(x: number, y: number): boolean {
    const mx = Math.min(MASK_W - 1, Math.max(0, Math.round(x * MASK_W)));
    const my = Math.min(MASK_H - 1, Math.max(0, Math.round(y * MASK_H)));
    return shape.mask[my * MASK_W + mx] === 1;
  }

  return {
    id: "gather",
    title: "聚沙成塔",
    brief: "全體協作。大家把光點推進字裡面，填滿就過關。→ 換下一個字。",

    enter(ctx) {
      shapeIndex = 0;
      load(ctx);
    },

    step(_dt, now, ctx) {
      ctx.field.stepActors(_dt, 0.4);

      inside = 0;
      total = 0;
      for (const a of ctx.field.actors.values()) {
        total++;
        a.flag = hit(a.x, a.y);
        if (a.flag) inside++;
      }

      if (!won && total > 0 && inside / total >= WIN_RATIO) {
        won = true;
        wonAt = now;
        ctx.publish({ hint: "成功了！抬頭看投影幕 🎉" });
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;

      // 底層：鏤空的字。成功之後整個亮起來。
      //
      // 用 drawImage 把離屏畫布整塊縮放貼上，不要逐格 fillRect ——
      // 240×135 是每幀三萬多次呼叫，投影機那台電腦扛不住，
      // 而且半透明的格子在接縫處會疊出網格紋。
      const glow = won ? 0.55 + 0.25 * Math.sin((now - wonAt) / 120) : 0.16;
      g.save();
      g.globalAlpha = glow;
      g.imageSmoothingEnabled = true;
      if (won) {
        // 成功時換成暖色：把遮罩當成 alpha 遮罩來上色
        g.globalCompositeOperation = "lighter";
      }
      g.drawImage(shape.canvas, 0, 0, w, h);
      g.restore();

      ctx.field.drawActors(ctx.surface, now, { names: total <= 60 });

      // 進度條。100 人的場合這是唯一看得出「還差多少」的東西。
      const ratio = total > 0 ? inside / total : 0;
      const barW = w * 0.6;
      const barH = unit * 2.2;
      const barX = (w - barW) / 2;
      const barY = h - unit * 7;

      g.fillStyle = "rgba(255,255,255,.14)";
      g.fillRect(barX, barY, barW, barH);
      g.fillStyle = won ? "#F2A72C" : "#A9CE3B";
      g.fillRect(barX, barY, barW * Math.min(1, ratio / WIN_RATIO), barH);

      g.fillStyle = "#FFFFFF";
      g.textAlign = "center";
      g.textBaseline = "bottom";
      g.font = `900 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(`${inside} / ${total}`, w / 2, barY - unit * 0.8);
    },

    key(e, ctx) {
      if (e.key === "ArrowRight" && shapeIndex < SHAPES.length - 1) {
        shapeIndex++;
        load(ctx);
        return true;   // 吃掉，不要讓主流程跳到下一關
      }
      if (e.key === "r" || e.key === "R") {
        load(ctx);
        return true;
      }
      return false;
    },
  };
}
