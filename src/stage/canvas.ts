/** 投影幕的畫布。投影機常常是 1080p 但瀏覽器縮放不是 1，dpr 沒處理的話字會糊。 */

export interface Surface {
  readonly ctx: CanvasRenderingContext2D;
  /** 畫布的實際像素寬高（已乘上 dpr），畫東西都用這個。 */
  readonly w: number;
  readonly h: number;
  /** 一個跟解析度無關的長度單位，用來算字級與半徑。 */
  readonly unit: number;
  dispose(): void;
}

export function createSurface(canvas: HTMLCanvasElement): Surface {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("拿不到 2d context");

  const surface = {
    ctx,
    w: 0,
    h: 0,
    unit: 0,
    dispose() {
      window.removeEventListener("resize", resize);
    },
  };

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    surface.w = canvas.width;
    surface.h = canvas.height;
    surface.unit = Math.min(canvas.width, canvas.height) / 100;
  }

  resize();
  window.addEventListener("resize", resize);
  return surface;
}
