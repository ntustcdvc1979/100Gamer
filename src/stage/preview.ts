/* ============================================================
   模型展示（stage.html?preview=pikmin、stage.html?preview=props）

   調 3D 模型、打光的時候用：四種皮克敏放大排一排，
   上排站著眨眼揮手，下排走路、拉東西、戴廚師帽。
   正式活動不會用到。
   ============================================================ */

import { DISPLAY_ORDER } from "../shared/teams";
import { carrot, pikmin, scenery } from "./cartoon";
import { cabbageBitSprite, foodSprite, fryerSprite, shakerSprite, wokSprite } from "./three/props";

export function drawPreview(g: CanvasRenderingContext2D, w: number, h: number, now: number, kind: "pikmin" | "props" = "pikmin"): void {
  if (kind === "props") {
    // 廚房道具：油炸籃三個高度、炒鍋生的與炒熟的
    scenery(g, w, h, now, "kitchen", 0.72);
    const s = Math.min(w / 3, h / 2);
    [0, 0.5, 1].forEach((lift, i) => {
      const img = fryerSprite(512, lift, 0.5);
      if (img) g.drawImage(img, (w / 3) * i + (w / 3 - s) / 2, 0, s, s);
    });
    [0, 1].forEach((heat, i) => {
      const img = wokSprite(512, heat);
      if (img) g.drawImage(img, (w / 2) * i + (w / 2 - s) / 2, h / 2, s, s);
    });
    // 做動作動畫用的小零件
    const parts = [foodSprite(256, "egg", false), foodSprite(256, "ham", false), foodSprite(256, "ham", true), shakerSprite(256),
      cabbageBitSprite(256, 0), cabbageBitSprite(256, 1), cabbageBitSprite(256, 2), cabbageBitSprite(256, 3)];
    const ps = w / parts.length;
    parts.forEach((img, i) => {
      if (img) g.drawImage(img, ps * i, h - ps, ps, ps);
    });
    return;
  }
  scenery(g, w, h, now, "meadow", 0.55);
  const colW = w / 4;
  DISPLAY_ORDER.forEach((id, i) => {
    const cx = colW * i + colW / 2;
    // 上排：葉子、花苞、花各一隻，站著自己做小動作
    ([0, 1, 2] as const).forEach((bloom, k) => {
      pikmin(g, cx + (k - 1) * colW * 0.3, h * 0.52, h * 0.36, id, { t: now, phase: i * 3 + k + 0.5, bloom });
    });
    pikmin(g, cx - colW * 0.22, h * 0.95, h * 0.3, id, { t: now, phase: i, walk: 0.6 });
    pikmin(g, cx + colW * 0.18, h * 0.95, h * 0.3, id, {
      t: now, phase: i, chef: i >= 2, reach: i < 2, lean: i < 2 ? -0.3 : 0,
    });
  });
  carrot(g, w * 0.5, h * 0.08, h * 0.12, now / 800);
}
