/* ============================================================
   拍照取色

   照片**不上傳**。整個流程都在這支手機上跑完，只把一個顏色送出去。
   100 支手機傳照片會直接壓垮中繼伺服器，而且拍到別人的臉就變成個資問題。

   取哪一塊：畫面正中央的一小塊，不是整張的平均。
   整張平均一定是灰的（背景、地板、天花板全混進去）。
   取中央等於「把要比的東西對準框框中間」，規則也好講。

   怎麼平均：先轉成線性 RGB 再平均。直接平均 sRGB 的位元組是錯的，
   會偏暗偏灰 —— 那是 gamma 編碼過的值。見 shared/color.ts。
   ============================================================ */

import { linearToRgb, srgbToLinear, type Rgb } from "../shared/color";

/** 取樣的邊長佔整張照片的比例 */
const SAMPLE = 0.3;
/** 縮到這個大小再取樣。手機拍出來動輒 4000px，全解析度讀是浪費。 */
const WORK = 240;

export interface Shot {
  rgb: Rgb;
  /** 縮圖，給玩家自己看剛剛拍到什麼。只留在這支手機上。 */
  preview: string;
}

export async function readPhoto(file: File): Promise<Shot> {
  const bitmap = await createBitmap(file);

  const scale = Math.min(1, WORK / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("拿不到 2d context");
  g.drawImage(bitmap, 0, 0, w, h);

  // 中央那一塊
  const sw = Math.max(1, Math.round(w * SAMPLE));
  const sh = Math.max(1, Math.round(h * SAMPLE));
  const sx = Math.round((w - sw) / 2);
  const sy = Math.round((h - sh) / 2);
  const data = g.getImageData(sx, sy, sw, sh).data;

  let lr = 0;
  let lg = 0;
  let lb = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    lr += srgbToLinear(data[i] ?? 0);
    lg += srgbToLinear(data[i + 1] ?? 0);
    lb += srgbToLinear(data[i + 2] ?? 0);
    n++;
  }

  const rgb = n > 0 ? linearToRgb(lr / n, lg / n, lb / n) : { r: 0, g: 0, b: 0 };

  // 畫一個取樣框在縮圖上，玩家才知道系統看的是哪一塊
  g.strokeStyle = "#ffffff";
  g.lineWidth = 2;
  g.strokeRect(sx, sy, sw, sh);

  if ("close" in bitmap) bitmap.close();

  return { rgb, preview: canvas.toDataURL("image/jpeg", 0.7) };
}

/** createImageBitmap 在舊 Safari 上沒有，退回 <img>。 */
async function createBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* 有些 HEIC 會失敗，往下退 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("讀不到這張照片"));
      img.src = url;
    });
    return img;
  } finally {
    // decode 完就可以放掉，canvas 上已經有像素了
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
