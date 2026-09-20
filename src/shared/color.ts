/* ============================================================
   顏色比對

   拍照找顏色那一關用的。兩件事要做對，不然玩起來會覺得「明明很像卻低分」：

   1. 平均要在「線性 RGB」做，不能直接平均 sRGB 的位元組。
      sRGB 是 gamma 編碼過的，直接平均會偏暗、偏灰。

   2. 距離要在 Lab 空間用 ΔE，不能用 RGB 的歐氏距離。
      RGB 距離跟人眼感覺差很遠 —— 深藍和黑在 RGB 上很近，看起來卻完全不同。
      這裡用 CIE94（圖藝權重）：比 ΔE76 更適合我們這種高彩度的題目
      （蘋果紅、香蕉黃），又比 ΔE2000 簡單得多、不容易寫錯。
   ============================================================ */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** sRGB 位元組 → 線性值。平均顏色之前一定要先做這一步。 */
export function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(255, Math.max(0, c * 255)));
}

/** 一組線性 RGB 的平均值換回 sRGB 位元組。 */
export function linearToRgb(lr: number, lg: number, lb: number): Rgb {
  return { r: linearToSrgb(lr), g: linearToSrgb(lg), b: linearToSrgb(lb) };
}

export function rgbToLab({ r, g, b }: Rgb): Lab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  // sRGB → XYZ（D65）
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;

  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE94 色差（圖藝權重）。0 = 一模一樣，數字越大差越多。 */
export function deltaE94(p: Lab, q: Lab): number {
  const dL = p.L - q.L;
  const c1 = Math.hypot(p.a, p.b);
  const c2 = Math.hypot(q.a, q.b);
  const dC = c1 - c2;
  const da = p.a - q.a;
  const db = p.b - q.b;
  // 浮點誤差會讓這個值變成很小的負數，開根號就 NaN
  const dH2 = Math.max(0, da * da + db * db - dC * dC);

  const sC = 1 + 0.045 * c1;
  const sH = 1 + 0.015 * c1;
  return Math.sqrt(dL * dL + (dC / sC) ** 2 + dH2 / (sH * sH));
}

/**
 * 色差換成 0–100 分。
 *
 * ΔE 25 以內算「看得出是同一個顏色」，所以那一段給比較陡的斜率，
 * 讓有認真找的人拿得到高分；ΔE 50 以上就歸零，避免亂拍也有安慰分。
 */
export function colorScore(target: Rgb, got: Rgb): number {
  const dE = deltaE94(rgbToLab(target), rgbToLab(got));
  return Math.max(0, Math.round(100 - dE * 2));
}

export function toHex({ r, g, b }: Rgb): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Rgb {
  const n = parseInt(hex.replace("#", ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
