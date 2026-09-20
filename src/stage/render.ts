/* ============================================================
   玩家的世界

   用 Canvas，不用 DOM 節點。100+ 個會動的東西如果各自是一個 div，
   瀏覽器會花所有時間在 layout 上，投影幕當場掉幀。

   位置只活在這支檔案的記憶體裡，永遠不寫回 state ——
   那會讓總下行乘上人數，是這個架構最貴的錯誤。

   Field 不決定「玩家怎麼動」，那是每個遊戲自己的事：
   聚沙成塔和選邊站要自由移動，四方拔河則是把搖桿變成隊伍推力、
   人不動。所以移動與繪製都是外面呼叫進來的。
   ============================================================ */

import { TEAMS, type TeamId } from "../shared/teams";
import type { Surface } from "./canvas";

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
  /** 這一關拿到的分數。換關卡時會被累進 total 然後歸零。 */
  score: number;
  /** 跨關卡累計的總分。排行榜看的是這個。 */
  total: number;
  /** 遊戲自己用的旗標，例如選邊站的「這題答對了」。 */
  flag: boolean;
  /** 遊戲自己指定的顏色，蓋掉隊伍色。拍照找顏色用它顯示每個人拍到什麼。 */
  tint: string | null;
}

/** 多久沒動就當這個人在放空，畫淡一點。 */
const IDLE_MS = 4000;

export interface TeamPush {
  /** 隊員搖桿的平均向量。用平均不是總和 —— 人數不均也公平。 */
  x: number;
  y: number;
  /** 隊上有多少人、其中多少人真的在推 */
  size: number;
  active: number;
}

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
        score: 0,
        total: 0,
        flag: false,
        tint: null,
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

  /** 只留下還在名單裡的人，離線的自動消失。 */
  retain(uids: Set<string>): void {
    for (const uid of [...this.actors.keys()]) {
      if (!uids.has(uid)) this.actors.delete(uid);
    }
    for (const uid of [...this.pending.keys()]) {
      if (!uids.has(uid)) this.pending.delete(uid);
    }
  }

  /**
   * 換遊戲時：把這一關的分數累進總分，然後歸零。
   * 總分不動 —— 排行榜要跨關卡累計。
   */
  bankScores(): void {
    for (const a of this.actors.values()) {
      a.total += a.score;
      a.score = 0;
    }
  }

  /** 把所有人的總分歸零。主控台的「重設分數」用。 */
  clearTotals(): void {
    for (const a of this.actors.values()) {
      a.total = 0;
      a.score = 0;
    }
  }

  /** 換遊戲時把這一關的狀態歸零，位置打散。 */
  reset(scatter = true): void {
    for (const a of this.actors.values()) {
      a.score = 0;
      a.flag = false;
      a.tint = null;
      if (scatter) {
        a.x = 0.1 + Math.random() * 0.8;
        a.y = 0.1 + Math.random() * 0.8;
      }
    }
  }

  /** 自由移動。speed 是「每秒最多跑幾個畫面寬」。 */
  stepActors(dt: number, speed = 0.35): void {
    for (const a of this.actors.values()) {
      a.x = clamp(a.x + a.vx * speed * dt);
      a.y = clamp(a.y + a.vy * speed * dt);
    }
  }

  /** 各隊的推力。四方拔河用這個，人不動，搖桿直接變成隊伍的力。 */
  teamPush(now: number): Record<TeamId, TeamPush> {
    const out = {} as Record<TeamId, TeamPush>;
    for (const id of Object.keys(TEAMS) as TeamId[]) {
      out[id] = { x: 0, y: 0, size: 0, active: 0 };
    }
    for (const a of this.actors.values()) {
      const t = out[a.team];
      if (!t) continue;
      t.size++;
      // 放空的人（超過 IDLE_MS 沒動）不算進推力，也不算進分母，
      // 不然一隊裡只要有人掛機，整隊的平均就被稀釋掉了。
      if (now - a.seenAt > IDLE_MS) continue;
      const mag = Math.hypot(a.vx, a.vy);
      if (mag < 0.15) continue;
      t.x += a.vx;
      t.y += a.vy;
      t.active++;
    }
    for (const t of Object.values(out)) {
      if (t.active > 0) {
        t.x /= t.active;
        t.y /= t.active;
      }
    }
    return out;
  }

  /** 畫所有玩家。遊戲可以自己決定要不要畫、畫在哪一層。 */
  drawActors(s: Surface, now: number, opts: { radius?: number; names?: boolean } = {}): void {
    const { ctx } = s;
    const r = opts.radius ?? s.unit * 1.5;
    const names = opts.names ?? true;

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = `700 ${Math.round(r * 0.9)}px system-ui, "Noto Sans TC", sans-serif`;

    for (const a of this.actors.values()) {
      const px = a.x * s.w;
      const py = a.y * s.h;
      const idle = now - a.seenAt > IDLE_MS;

      ctx.globalAlpha = idle ? 0.28 : 1;
      ctx.fillStyle = a.tint ?? TEAMS[a.team].color;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();

      // 這一題答對／已經進到目標區的人加一圈白邊，遠遠看得出來
      if (a.flag) {
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = Math.max(2, r * 0.22);
        ctx.stroke();
      }

      if (names) {
        ctx.globalAlpha = idle ? 0.28 : 0.85;
        ctx.fillStyle = "#FFFFFF";
        ctx.fillText(a.name, px, py + r * 1.25);
      }
    }
    ctx.globalAlpha = 1;
  }
}

function clamp(v: number): number {
  return v < 0.02 ? 0.02 : v > 0.98 ? 0.98 : v;
}
