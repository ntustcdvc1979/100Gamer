/* ============================================================
   模型展示（stage.html?preview=pikmin、stage.html?preview=props）

   調 3D 模型、打光的時候用：四種皮克敏放大排一排，
   上排站著眨眼揮手，下排走路、拉東西、戴廚師帽。
   正式活動不會用到。
   ============================================================ */

import { DISPLAY_ORDER } from "../shared/teams";
import { carrot, pikmin, scenery } from "./cartoon";
import { fryerSprite, wokSprite } from "./three/props";

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
    return;
  }
  scenery(g, w, h, now, "meadow", 0.55);
  const colW = w / 4;
  DISPLAY_ORDER.forEach((id, i) => {
    const cx = colW * i + colW / 2;
    pikmin(g, cx, h * 0.5, h * 0.42, id, { t: now, phase: i, wave: i % 2 === 0 });
    pikmin(g, cx - colW * 0.22, h * 0.95, h * 0.3, id, { t: now, phase: i, walk: 0.6 });
    pikmin(g, cx + colW * 0.18, h * 0.95, h * 0.3, id, {
      t: now, phase: i, chef: i >= 2, reach: i < 2, lean: i < 2 ? -0.3 : 0,
    });
  });
  carrot(g, w * 0.5, h * 0.08, h * 0.12, now / 800);
}
