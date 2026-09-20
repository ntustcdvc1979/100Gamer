/* ============================================================
   遊戲四：拍照找顏色（個人賽）

   出題「蘋果紅」，大家在 60 秒內在現場找一個最像的東西拍下來。
   可以一直重拍，但**只能上傳一次** —— 按下「就是這張」就定案。
   分數在時間到才公布，投影幕依分數高低秀出照片與分數。

   ⚠️ 照片會離開手機。

   原本的設計是「只送顏色、照片留在手機上」。改成要在投影幕上秀照片
   之後就不可能了，所以做了三件事把代價壓下來：

     1. 只送縮圖（200px、JPEG 0.55，約 8–12KB）。100 張約 1MB，
        一次性，中繼機吃得下。原圖不會離開手機。
     2. 伺服器只轉不存，投影幕也只留在記憶體，重整就沒了。
     3. 手機上明講「這張會投到大螢幕」，讓人自己決定拍什麼。

   為什麼分數要等時間到才公布：邊拍邊看分數的話，大家會站在原地
   對著同一個東西微調角度刷分，而不是跑去找更像的東西。

   分數怎麼算：src/shared/color.ts 的 CIE94 色差。不能用 RGB 歐氏距離，
   那跟人眼差很遠 —— 深藍和黑在 RGB 上很近，看起來卻完全不同。
   ============================================================ */

import { colorScore, fromHex } from "../../shared/color";
import type { PlayerAction } from "../../net/schema";
import type { Game, GameContext } from "./types";

interface Prompt {
  label: string;
  hex: string;
}

/** 三題。挑的都是現場找得到、而且彩度夠高分得出高下的顏色。 */
const PROMPTS: Prompt[] = [
  { label: "蘋果紅", hex: "#D9333F" },
  { label: "香蕉黃", hex: "#F2C230" },
  { label: "天空藍", hex: "#4FA3D9" },
];

const ROUND_MS = 60_000;
/** 公布時秀幾張照片。投影幕上要看得清楚，不能全部塞進去。 */
const SHOW_TOP = 8;

interface Shot {
  hex: string;
  score: number;
  /** 已經載進來的縮圖，canvas 只能畫 Image 不能畫 data URI 字串 */
  img: HTMLImageElement;
}

export function createPhotoColorGame(): Game {
  let index = 0;
  let running = false;
  let revealed = false;
  let endsAt = 0;
  /** 這一題誰交了什麼。一人一張，交了就不能換。 */
  const shots = new Map<string, Shot>();
  let ranked: [string, Shot][] = [];

  function prompt(): Prompt {
    return PROMPTS[index] as Prompt;
  }

  function announce(ctx: GameContext, hint: string): void {
    ctx.publish({
      phase: "playing",
      game: "photocolor",
      round: index + 1,
      control: "camera",
      targetColor: prompt().hex,
      accepting: running,
      revealed,
      hint,
      options: [],
    });
  }

  function load(ctx: GameContext): void {
    running = false;
    revealed = false;
    shots.clear();
    ranked = [];
    for (const a of ctx.field.actors.values()) {
      a.tint = null;
      a.flag = false;
    }
    announce(ctx, `第 ${index + 1} 題：找「${prompt().label}」，等主持人開始`);
  }

  function reveal(ctx: GameContext): void {
    running = false;
    revealed = true;
    ranked = [...shots.entries()].sort((a, b) => b[1].score - a[1].score);
    // 分數這時候才進帳，前面只是收件
    for (const [uid, shot] of ranked) {
      const actor = ctx.field.actors.get(uid);
      if (actor) actor.score = shot.score;
    }
    const best = ranked[0];
    announce(
      ctx,
      best
        ? `公布了！第一名 ${ctx.field.actors.get(best[0])?.name ?? ""}　${best[1].score} 分`
        : "沒有人交卷",
    );
  }

  return {
    id: "photocolor",
    title: "拍照找顏色",
    brief:
      "個人賽。T 開始 60 秒，再按 T 提早公布。可以重拍但只能上傳一次。→ 換下一題。照片會投在畫面上。",

    enter(ctx) {
      index = 0;
      ctx.field.reset(false);
      load(ctx);
    },

    step(_dt, now, ctx) {
      if (running && now >= endsAt) reveal(ctx);
    },

    action(uid, a: PlayerAction, ctx) {
      if (a.k !== "color" || !running) return;
      // 一人一張，先到先算。手機那邊也鎖了，這裡是第二道 ——
      // 別人改過的客戶端不該能一直洗。
      if (shots.has(uid)) return;
      const actor = ctx.field.actors.get(uid);
      if (!actor) return;

      // 不採信手機報的任何分數，投影幕自己用 hex 算。
      const score = colorScore(fromHex(prompt().hex), fromHex(a.hex));

      const img = new Image();
      img.src = a.thumb;

      shots.set(uid, { hex: a.hex, score, img });
      actor.tint = a.hex;
      actor.flag = true;
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const p = prompt();

      // 目標色票，占畫面上緣一大條。後排要看得到顏色本身。
      const swatchH = h * 0.22;
      g.fillStyle = p.hex;
      g.fillRect(0, 0, w, swatchH);

      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "rgba(0,0,0,.55)";
      g.font = `900 ${Math.round(unit * 8)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(p.label, w / 2, swatchH / 2);

      if (revealed) {
        drawResults(ctx, swatchH);
        return;
      }

      // 收件中：只說交了幾個人，不透露任何分數。
      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 5)}px system-ui, "Noto Sans TC", sans-serif`;
      const left = running ? Math.ceil((endsAt - now) / 1000) : 0;
      g.fillText(
        running ? `${left} 秒　已交 ${shots.size}` : `準備中`,
        w / 2,
        swatchH + unit * 5,
      );
      g.font = `700 ${Math.round(unit * 2.6)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillStyle = "rgba(255,255,255,.6)";
      g.fillText("分數時間到才公布", w / 2, swatchH + unit * 10);

      // 交過的人亮起他拍到的顏色，但不顯示分數
      ctx.field.drawActors(ctx.surface, now, { radius: unit * 1.6, names: false });
    },

    running: () => running,

    /* 沒有暫停：大家已經散到場地各處在拍照了，凍住畫面幫不上任何忙。 */
    run(on, ctx) {
      if (!on) return false;
      if (running || revealed) return true;
      running = true;
      endsAt = performance.now() + ROUND_MS;
      announce(ctx, `找「${prompt().label}」，拍下來！可以重拍，但只能上傳一次`);
      return true;
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (revealed) return true;
        if (running) {
          // 大家都交完了就不用乾等 —— 再按一次直接公布，
          // 跟選邊站同一個手感。
          reveal(ctx);
          return true;
        }
        running = true;
        endsAt = performance.now() + ROUND_MS;
        announce(ctx, `找「${prompt().label}」，拍下來！可以重拍，但只能上傳一次`);
        return true;
      }
      if (e.key === "ArrowRight" && index < PROMPTS.length - 1) {
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

  /** 公布畫面：照片依分數高低排成一列，越前面越像。 */
  function drawResults(ctx: GameContext, top: number): void {
    const { ctx: g, w, h, unit } = ctx.surface;

    if (ranked.length === 0) {
      g.fillStyle = "rgba(255,255,255,.6)";
      g.font = `900 ${Math.round(unit * 5)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText("沒有人交卷", w / 2, h / 2);
      return;
    }

    const show = ranked.slice(0, SHOW_TOP);
    const cols = Math.min(4, show.length);
    const rows = Math.ceil(show.length / cols);
    const areaY = top + unit * 4;
    const areaH = h - areaY - unit * 4;
    const cellW = w / cols;
    const cellH = areaH / rows;
    const photoH = cellH * 0.62;

    show.forEach(([uid, shot], i) => {
      const cx = cellW * (i % cols) + cellW / 2;
      const cy = areaY + cellH * Math.floor(i / cols);
      const actor = ctx.field.actors.get(uid);

      // 照片。等比縮到格子裡，不裁切 —— 拍直式的人也要看得完整。
      const iw = shot.img.naturalWidth || 4;
      const ih = shot.img.naturalHeight || 3;
      const scale = Math.min((cellW * 0.6) / iw, photoH / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      if (shot.img.complete && iw > 1) {
        g.drawImage(shot.img, cx - dw / 2, cy + (photoH - dh) / 2, dw, dh);
      }

      // 名次角標
      g.fillStyle = i === 0 ? "#F2A72C" : "rgba(255,255,255,.75)";
      g.textAlign = "center";
      g.textBaseline = "top";
      g.font = `900 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(`${i + 1}`, cx - dw / 2 - unit * 2, cy + photoH * 0.3);

      // 拍到的顏色 + 名字 + 分數
      const infoY = cy + photoH + unit * 1.2;
      g.fillStyle = shot.hex;
      g.fillRect(cx - unit * 8, infoY, unit * 3, unit * 3);
      g.fillStyle = "#FFFFFF";
      g.textAlign = "left";
      g.font = `700 ${Math.round(unit * 2.4)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(actor?.name ?? "", cx - unit * 4, infoY + unit * 1.4);
      g.font = `900 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillStyle = i === 0 ? "#F2A72C" : "#FFFFFF";
      g.textAlign = "right";
      g.fillText(`${shot.score}`, cx + unit * 8, infoY + unit * 1.4);
    });

    if (ranked.length > SHOW_TOP) {
      g.textAlign = "center";
      g.fillStyle = "rgba(255,255,255,.5)";
      g.font = `700 ${Math.round(unit * 2.2)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(`還有 ${ranked.length - SHOW_TOP} 個人交了`, w / 2, h - unit * 3);
    }
  }
}
