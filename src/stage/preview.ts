/* ============================================================
   模型展示（stage.html?preview=pikmin）

   調 3D 模型、打光的時候用：四種皮克敏放大排一排，
   上排站著眨眼揮手，下排走路、拉東西、戴廚師帽。
   正式活動不會用到。
   ============================================================ */

import { DISPLAY_ORDER } from "../shared/teams";
import { carrot, pikmin, scenery } from "./cartoon";

export function drawPreview(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
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
