/* ============================================================
   遊戲四：拍照找顏色（個人賽）

   出題「蘋果紅」，大家在 60 秒內在現場找一個最像的東西拍下來，
   比對顏色相似度給分。

   ⚠️ 照片不上傳。

   這是這一關最重要的設計決定。100 支手機同時傳照片，
   就算壓到 200KB 也是 20MB 打在一台 256MB 的中繼伺服器上，
   而且那是個資 —— 拍到別人的臉就留在伺服器上了。
   所以顏色在手機上算完（play/camera.ts），只送一個 hex 和分數上來，
   幾十個 bytes。照片從頭到尾沒離開過那支手機。

   分數怎麼算：src/shared/color.ts 的 CIE94 色差。不能用 RGB 歐氏距離，
   那跟人眼差很遠 —— 深藍和黑在 RGB 上很近，看起來卻完全不同。
   投影幕收到手機報的分數之後會自己用 hex 再算一次，不直接採信。
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

export function createPhotoColorGame(): Game {
  let index = 0;
  let running = false;
  let endsAt = 0;
  /** 這一題誰交了什麼。換題目時清掉。 */
  const shots = new Map<string, { hex: string; score: number }>();

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
      hint,
      options: [],
    });
  }

  function load(ctx: GameContext): void {
    running = false;
    shots.clear();
    for (const a of ctx.field.actors.values()) {
      a.tint = null;
      a.flag = false;
    }
    announce(ctx, `第 ${index + 1} 題：找「${prompt().label}」，等主持人開始`);
  }

  return {
    id: "photocolor",
    title: "拍照找顏色",
    brief: "個人賽。出題後按 T 開始 60 秒，大家拍照比對顏色。→ 換下一題。照片不上傳。",

    enter(ctx) {
      index = 0;
      ctx.field.reset(false);
      load(ctx);
    },

    step(_dt, now, ctx) {
      if (running && now >= endsAt) {
        running = false;
        announce(ctx, `時間到！${shots.size} 個人交卷`);
      }
    },

    action(uid, a: PlayerAction, ctx) {
      if (a.k !== "color" || !running) return;
      const actor = ctx.field.actors.get(uid);
      if (!actor) return;

      // 不直接採信手機報的分數 —— 用 hex 自己再算一次。
      // 手機算一次是為了讓玩家馬上看到結果，不是為了當權威。
      const score = colorScore(fromHex(prompt().hex), fromHex(a.hex));

      const prev = shots.get(uid);
      // 一題只能交一次最好的。重拍可以，但只留最高分，
      // 不然手快的人狂拍就贏了。
      if (prev && prev.score >= score) return;

      shots.set(uid, { hex: a.hex, score });
      actor.score += score - (prev?.score ?? 0);
      actor.tint = a.hex;
      actor.flag = true;
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const p = prompt();

      // 目標色票，占畫面上緣一大條。後排要看得到顏色本身。
      const swatchH = h * 0.26;
      g.fillStyle = p.hex;
      g.fillRect(0, 0, w, swatchH);

      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "rgba(0,0,0,.55)";
      g.font = `900 ${Math.round(unit * 9)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(p.label, w / 2, swatchH / 2);

      // 倒數
      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 5)}px system-ui, "Noto Sans TC", sans-serif`;
      const left = running ? Math.ceil((endsAt - now) / 1000) : 0;
      g.fillText(
        running ? `${left} 秒　已交 ${shots.size}` : `按 T 開始　已交 ${shots.size}`,
        w / 2,
        swatchH + unit * 5,
      );

      // 每個人拍到的顏色就是他的點的顏色，一眼看得出誰找得準
      ctx.field.drawActors(ctx.surface, now, { radius: unit * 1.6, names: false });

      // 前五名，連同他拍到的色塊一起秀
      const top = [...ctx.field.actors.entries()]
        .filter(([uid]) => shots.has(uid))
        .sort((a, b) => (shots.get(b[0])?.score ?? 0) - (shots.get(a[0])?.score ?? 0))
        .slice(0, 5);

      if (top.length > 0) {
        const boxH = unit * (4 + top.length * 4.5);
        g.fillStyle = "rgba(10,10,14,.8)";
        g.fillRect(unit * 2, h - boxH - unit * 2, unit * 34, boxH);

        g.textAlign = "left";
        g.fillStyle = "#FFFFFF";
        g.font = `900 ${Math.round(unit * 2.4)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText("最接近的", unit * 4, h - boxH + unit * 0.5);

        top.forEach(([uid, actor], i) => {
          const shot = shots.get(uid);
          if (!shot) return;
          const y = h - boxH + unit * (4.5 + i * 4.5);
          g.fillStyle = shot.hex;
          g.fillRect(unit * 4, y - unit * 1.4, unit * 5, unit * 2.8);
          g.fillStyle = "#FFFFFF";
          g.font = `700 ${Math.round(unit * 2.2)}px system-ui, "Noto Sans TC", sans-serif`;
          g.fillText(`${actor.name}`, unit * 10.5, y);
          g.textAlign = "right";
          g.fillText(`${shot.score}`, unit * 34, y);
          g.textAlign = "left";
        });
      }
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        running = !running;
        if (running) endsAt = performance.now() + ROUND_MS;
        announce(ctx, running ? `找「${prompt().label}」，拍下來！` : "暫停");
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
}
