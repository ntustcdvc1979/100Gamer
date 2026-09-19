/* ============================================================
   投影幕渲染

   用 Canvas，不用 DOM 節點。100+ 個會動的東西如果各自是一個 div，
   瀏覽器會花所有時間在 layout 上，投影幕當場掉幀。

   位置只活在這支檔案的記憶體裡，永遠不寫回 state ——
   那會讓總下行乘上人數，是這個架構最貴的錯誤。
   ============================================================ */

import { TEAMS, type TeamId } from "../shared/teams";

export interface Actor {
  name: string;
  team: TeamId;
  /** 畫面座標，0..1（跟解析度無關，投影機換了也不用改） */
  x: number;
  y: number;
  /** 最新的搖桿向量 */
  vx: number;
  vy: number;
  /** 最後一次收到輸入的時間，用來畫「這個人還醒著」 */
  seenAt: number;
}

const SPEED = 0.35; // 每秒最多移動幾個畫面寬
const IDLE_MS = 4000;

export class Field {
  readonly actors = new Map<string, Actor>();

  /**
   * 比玩家名單先到的輸入。
   *
   * inputs 和 players 是兩個獨立的訂閱，誰先到不保證。丟掉早到的輸入的話，
   * 那個人會卡在原地直到他下一次動 —— 備用筆電接手時最明顯：
   * 畫面上所有人都不會動，直到每個人各自再推一次搖桿。
   */
  private readonly pending = new Map<string, { vx: number; vy: number; seenAt: number }>();

  private readonly ctx: CanvasRenderingContext2D;
  private raf = 0;
  private last = performance.now();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("拿不到 2d context");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", this.resize);
  }

  private resize = (): void => {
    // 投影機常常是 1080p 但瀏覽器縮放不是 1，dpr 沒處理的話字會糊。
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
  };

  upsert(uid: string, name: string, team: TeamId): Actor {
    let a = this.actors.get(uid);
    if (!a) {
      // 新來的人從畫面中間附近隨機出現，不要全部疊在同一點
      a = {
        name,
        team,
        x: 0.5 + (Math.random() - 0.5) * 0.5,
        y: 0.5 + (Math.random() - 0.5) * 0.5,
        vx: 0,
        vy: 0,
        seenAt: 0,
      };
      this.actors.set(uid, a);
      const early = this.pending.get(uid);
      if (early) {
        a.vx = early.vx;
        a.vy = early.vy;
        a.seenAt = early.seenAt;
        this.pending.delete(uid);
      }
    }
    a.name = name;
    a.team = team;
    return a;
  }

  /** 收到搖桿輸入。玩家名單還沒到的話先收著，upsert 的時候補上。 */
  applyInput(uid: string, vx: number, vy: number, seenAt: number): void {
    const a = this.actors.get(uid);
    if (a) {
      a.vx = vx;
      a.vy = vy;
      a.seenAt = seenAt;
    } else {
      this.pending.set(uid, { vx, vy, seenAt });
    }
  }

  remove(uid: string): void {
    this.actors.delete(uid);
    this.pending.delete(uid);
  }

  /** 只留下還在名單裡的人，離線的自動消失（靠 onDisconnect 把節點清掉）。 */
  retain(uids: Set<string>): void {
    for (const uid of [...this.actors.keys()]) {
      if (!uids.has(uid)) this.actors.delete(uid);
    }
    for (const uid of [...this.pending.keys()]) {
      if (!uids.has(uid)) this.pending.delete(uid);
    }
  }

  start(): void {
    const frame = (now: number): void => {
      const dt = Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      this.step(dt);
      this.draw(now);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
  }

  private step(dt: number): void {
    for (const a of this.actors.values()) {
      a.x = clamp01(a.x + a.vx * SPEED * dt);
      a.y = clamp01(a.y + a.vy * SPEED * dt);
    }
  }

  private draw(now: number): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    const r = Math.max(10, Math.min(w, h) * 0.018);

    ctx.fillStyle = "#14141A";
    ctx.fillRect(0, 0, w, h);

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = `700 ${Math.round(r * 0.9)}px system-ui, "Noto Sans TC", sans-serif`;

    for (const a of this.actors.values()) {
      const px = a.x * w;
      const py = a.y * h;
      const idle = now - a.seenAt > IDLE_MS;

      ctx.globalAlpha = idle ? 0.28 : 1;
      ctx.fillStyle = TEAMS[a.team].color;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = idle ? 0.28 : 0.85;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(a.name, px, py + r * 1.25);
    }
    ctx.globalAlpha = 1;
  }
}

function clamp01(v: number): number {
  return v < 0.02 ? 0.02 : v > 0.98 ? 0.98 : v;
}
