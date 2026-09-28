/* ============================================================
   等待大廳（開場畫面）

   大家在掃 QR、選隊的時候投影幕上放這個：主視覺的四種皮克敏，
   加上每一個已經加入的人 —— 他們會變成一隻自己隊伍顏色的小皮克敏，
   從土裡冒出來，在草地上走來走去，頭上寫著名字。

   ⚠️ 畫面上刻意不寫人數，也不寫各隊幾個人。
   那些數字只給主持人看（主控台上有）。投影幕上寫「火象 3 人、水象 30 人」
   只會讓人少的那一隊在開始之前就先洩氣；而一片走來走去的皮克敏本身
   就看得出場子熱不熱，不需要數字。

   掃進來的人要馬上在大螢幕上看到自己 —— 那是「我連上了」最好的回饋，
   比手機上的「已連線」三個字有感得多。

   等待的時候手機上是一支搖桿：推搖桿就能帶著自己的皮克敏在草地上走，
   搖一搖手機（或按「打招呼」）牠就舉手揮一揮。放著不動三秒，
   牠又會自己開始閒晃。
   ============================================================ */

import { DISPLAY_ORDER, TEAMS, type TeamId } from "../../shared/teams";
import { bigText, flushPikmin, font, pikmin, roundRect, scenery, shade, teamCardBackdrop, woodSign } from "../cartoon";
import type { Game, GameContext } from "./types";

interface Walker {
  team: TeamId;
  name: string;
  /** 0..1 畫面座標 */
  x: number;
  y: number;
  tx: number;
  ty: number;
  speed: number;
  /** 走到目標之後發呆到什麼時候 */
  restUntil: number;
  face: 1 | -1;
  /** 從土裡冒出來的時刻 */
  born: number;
  phase: number;
  /** 最後一次被搖桿推動的時刻（之後三秒內不自己亂走，站在玩家放開的地方） */
  drivenAt: number;
  /** 被搖桿推著走的那一幀：走路動畫的速度，0 = 沒在推 */
  drive: number;
  /** 收到的搖動累計數，用來判斷「剛剛又搖了」 */
  shakes: number;
  /** 揮手揮到什麼時候 */
  greetUntil: number;
}

/** 從土裡冒出來要多久（毫秒） */
const SPROUT_MS = 700;
/** 搖桿推到底時每秒走多遠（畫面寬／高的比例）。往前後走慢一點，才像是在草地上有景深。 */
const DRIVE_X = 0.16;
const DRIVE_Y = 0.07;
/** 能走的範圍：草地那一條，不要走到隊伍卡和木牌上 */
const AREA = { x0: 0.03, x1: 0.97, y0: 0.74, y1: 0.97 };
/** 搖桿比這個小就當作沒在推（手指放在上面會有一點點抖） */
const DEAD = 0.12;
/** 放開搖桿多久之後，又開始自己閒晃 */
const DRIVE_HOLD_MS = 3000;
/** 搖一下手機，揮手揮多久 */
const GREET_MS = 1800;

export function createLobbyGame(): Game {
  const walkers = new Map<string, Walker>();
  /** 第一次同步完名單之前不放音效 —— 投影幕重整時已經在的人不是「剛加入」。 */
  let primed = false;

  function randomSpot(): { x: number; y: number } {
    return { x: 0.05 + Math.random() * 0.9, y: 0.8 + Math.random() * 0.15 };
  }

  function sync(ctx: GameContext, now: number): void {
    const seen = new Set<string>();
    for (const [uid, a] of ctx.field.actors) {
      seen.add(uid);
      const w = walkers.get(uid);
      if (w) {
        w.name = a.name;
        w.team = a.team;
        continue;
      }
      const p = randomSpot();
      walkers.set(uid, {
        team: a.team,
        name: a.name,
        x: p.x, y: p.y, tx: p.x, ty: p.y,
        speed: 0.025 + Math.random() * 0.03,
        restUntil: now + 800 + Math.random() * 1500,
        face: Math.random() < 0.5 ? 1 : -1,
        // 投影幕剛打開時已經在的人直接站著，不要一百隻同時從土裡冒出來
        born: primed ? now : now - SPROUT_MS,
        phase: Math.random() * 10,
        drivenAt: -1e9,
        drive: 0,
        // 從進大廳那一刻的累計數開始算，前面關卡搖的不算
        shakes: a.shakes,
        greetUntil: 0,
      });
      if (primed) ctx.sfx("join");
    }
    for (const uid of [...walkers.keys()]) if (!seen.has(uid)) walkers.delete(uid);
    primed = true;
  }

  return {
    id: "lobby",
    title: "等待大廳",
    brief: "開場畫面。大家掃 QR 選隊，加入的人會變成皮克敏出現在草地上。",
    cartoon: true,
    bgm: "lobby",

    enter(ctx) {
      primed = false;
      walkers.clear();
      ctx.publish({
        phase: "lobby",
        game: "lobby",
        round: 0,
        // 大廳裡手機是搖桿：帶自己的皮克敏在投影幕上散步
        control: "joystick",
        accepting: true,
        hint: "推搖桿帶你的皮克敏散步，搖一搖手機跟大家打招呼！",
        options: [],
      });
    },

    step(dt, now, ctx) {
      sync(ctx, now);
      for (const [uid, w] of walkers) {
        const a = ctx.field.actors.get(uid);
        w.drive = 0;
        if (a) {
          // 又搖了：舉手打招呼
          if (a.shakes > w.shakes) w.greetUntil = now + GREET_MS;
          w.shakes = a.shakes;
        }
        if (now - w.born < SPROUT_MS) continue; // 還在從土裡冒出來

        // 玩家在推搖桿：照搖桿走（輸入太久沒更新就當作放開了）
        const mag = a && now - a.seenAt < 1500 ? Math.hypot(a.vx, a.vy) : 0;
        if (a && mag > DEAD) {
          const k = Math.min(1, mag);
          w.x = Math.max(AREA.x0, Math.min(AREA.x1, w.x + (a.vx / mag) * k * DRIVE_X * dt));
          w.y = Math.max(AREA.y0, Math.min(AREA.y1, w.y + (a.vy / mag) * k * DRIVE_Y * dt));
          if (Math.abs(a.vx) > 0.05) w.face = a.vx > 0 ? 1 : -1;
          w.drive = 0.35 + k * 0.65;
          w.drivenAt = now;
          // 放開之後從這裡開始發呆，不要一放手就衝回原本的目標
          w.tx = w.x;
          w.ty = w.y;
          w.restUntil = now + DRIVE_HOLD_MS;
          continue;
        }
        if (now < w.restUntil) continue;
        const dx = w.tx - w.x;
        const dy = w.ty - w.y;
        const d = Math.hypot(dx, dy);
        if (d < 0.01) {
          const p = randomSpot();
          w.tx = p.x;
          w.ty = p.y;
          w.restUntil = now + 1000 + Math.random() * 2500;
          continue;
        }
        const stepLen = Math.min(d, w.speed * dt);
        w.x += (dx / d) * stepLen;
        w.y += (dy / d) * stepLen;
        if (Math.abs(dx) > 0.002) w.face = dx > 0 ? 1 : -1;
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      scenery(g, w, h, now, "meadow", 0.62);

      /* ---- 標題 ----
         置中在 QR 左邊那一塊，不要被右上角的 QR 蓋到。 */
      // 內容只排在 QR 左邊那一塊。QR 的實際位置問 stage，不要自己猜比例。
      const right = Math.min(w * 0.97, ctx.qrLeft() - unit * 2);
      const titleX = right / 2;
      bigText(g, "四象星座 × 皮克敏", titleX, h * 0.09, unit * 7.5, "#1E4FB8");
      bigText(g, "不同的我們，組成最強的團隊！", titleX, h * 0.17, unit * 3.4, "#2A2A30");

      /* ---- 四張隊伍卡 ----
         跟主視覺一樣由左到右：火、土、水、風。 */
      const left = w * 0.03;
      const gap = unit * 2;
      const cw = (right - left - gap * 3) / 4;
      const top = h * 0.23;
      const ch = h * 0.38;
      // 卡片窄的時候（4:3 投影機、QR 比較寬）字跟著縮，不要超出卡片
      const k = Math.min(1, cw / (unit * 22));
      DISPLAY_ORDER.forEach((id, i) => {
        const x = left + i * (cw + gap);
        // 主視覺那樣，每張卡有自己的場景：岩漿、陽光石堆、水面、風
        teamCardBackdrop(g, x, top, cw, ch, id, now, unit);
        // 吉祥物：輪流揮手，才不會四隻一起動得像機器人
        const waving = Math.floor(now / 1800) % 4 === i;
        pikmin(g, x + cw / 2, top + ch * 0.8, Math.min(ch * 0.6, cw * 1.05), id, {
          t: now, phase: i * 0.7, wave: waving, face: i < 2 ? 1 : -1,
        });
      });
      // 先把吉祥物畫上去，隊名和膠囊再蓋在上面（主視覺也是字在最上層）
      flushPikmin(g);

      DISPLAY_ORDER.forEach((id, i) => {
        const t = TEAMS[id];
        const x = left + i * (cw + gap);
        // 隊名
        bigText(g, `${t.name}星座`, x + cw / 2, top + unit * 4.2, unit * 3.6 * k, t.light ? "#3A4A66" : shade(t.color, -0.3));

        // 皮克敏名稱膠囊
        const pillY = top + ch * 0.86;
        g.font = font(unit * 2.5 * k);
        const pw = g.measureText(t.pikmin).width + unit * 3 * k;
        g.fillStyle = t.light ? "#FFFFFF" : t.color;
        roundRect(g, x + cw / 2 - pw / 2, pillY - unit * 1.9, pw, unit * 3.8, unit * 1.9);
        g.fill();
        g.strokeStyle = t.light ? "#B8C0CE" : "#FFFFFF";
        g.lineWidth = unit * 0.35;
        g.stroke();
        g.fillStyle = t.ink;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(t.pikmin, x + cw / 2, pillY + unit * 0.1);

        g.font = font(unit * 1.9 * k);
        g.fillStyle = t.light ? "#3A4A66" : shade(t.color, -0.45);
        g.fillText(`${t.trait} MAX`, x + cw / 2, top + ch - unit * 1.2 - unit * 0.3);
      });

      woodSign(g, titleX, h * 0.655, "掃 QR code 加入，選好你的皮克敏！", unit * 2.6, unit);

      /* ---- 已經加入的人 ----
         照 y 排序再畫，後面的先畫，前面的蓋在上面，才有遠近感。 */
      const sorted = [...walkers.values()].sort((a, b) => a.y - b.y);
      const many = sorted.length > 40;
      for (const wk of sorted) {
        const depth = 0.8 + (wk.y - 0.8) * 1.8; // 越下面越近、越大
        const size = unit * 11 * depth * (many ? 0.75 : 1);
        const px = wk.x * w;
        const py = wk.y * h;
        const age = now - wk.born;

        if (age < SPROUT_MS) {
          // 從土裡「啵」一聲冒出來：先一個土堆，皮克敏從小彈到正常大小
          const k = age / SPROUT_MS;
          const pop = k < 0.7 ? (k / 0.7) * 1.15 : 1.15 - ((k - 0.7) / 0.3) * 0.15;
          g.fillStyle = "#6B4424";
          g.beginPath();
          g.ellipse(px, py, size * 0.3 * (1 - k * 0.5), size * 0.08, 0, 0, Math.PI * 2);
          g.fill();
          pikmin(g, px, py, size * pop, wk.team, { t: now, phase: wk.phase });
        } else {
          const walking = wk.drive > 0 ? wk.drive : now >= wk.restUntil ? 0.6 : 0;
          pikmin(g, px, py, size, wk.team, {
            t: now, phase: wk.phase, walk: walking, face: wk.face,
            greet: now < wk.greetUntil,
          });
        }
      }
      // 皮克敏一次畫上去，名字再寫在上面
      flushPikmin(g);

      for (const wk of sorted) {
        const depth = 0.8 + (wk.y - 0.8) * 1.8;
        const size = unit * 11 * depth * (many ? 0.75 : 1);
        const px = wk.x * w;
        const py = wk.y * h;
        // 名字。人一多就只寫前面那一排，不然整片都是字。
        // 正在用搖桿走、或正在打招呼的人一定寫 —— 玩家要找得到自己。
        const busy = now - wk.drivenAt < DRIVE_HOLD_MS || now < wk.greetUntil;
        if (!many || wk.y > 0.9 || busy) {
          g.font = font(unit * 1.7);
          g.textAlign = "center";
          g.textBaseline = "bottom";
          g.lineJoin = "round";
          g.strokeStyle = "rgba(255,255,255,.95)";
          g.lineWidth = unit * 0.5;
          g.strokeText(wk.name, px, py - size * 1.02);
          g.fillStyle = "#2A2A30";
          g.fillText(wk.name, px, py - size * 1.02);
        }
      }
    },
  };
}
