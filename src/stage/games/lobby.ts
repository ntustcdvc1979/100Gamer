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
   ============================================================ */

import { DISPLAY_ORDER, TEAMS, type TeamId } from "../../shared/teams";
import { bigText, card, font, meadow, pikmin, roundRect, shade, sky, woodSign } from "../cartoon";
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
}

/** 從土裡冒出來要多久（毫秒） */
const SPROUT_MS = 700;

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
        control: undefined,
        accepting: false,
        hint: "選好你的皮克敏，等主持人開始！",
        options: [],
      });
    },

    step(dt, now, ctx) {
      sync(ctx, now);
      for (const w of walkers.values()) {
        if (now - w.born < SPROUT_MS) continue; // 還在從土裡冒出來
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
      sky(g, w, h, now);
      meadow(g, w, h, h * 0.62, now);

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
        const t = TEAMS[id];
        const x = left + i * (cw + gap);
        const grad = g.createLinearGradient(0, top, 0, top + ch);
        grad.addColorStop(0, t.light ? "#F4F7FB" : shade(t.color, 0.55));
        grad.addColorStop(1, t.light ? "#DCE3EE" : shade(t.color, 0.1));
        card(g, x, top, cw, ch, grad, unit);

        // 隊名
        bigText(g, `${t.name}星座`, x + cw / 2, top + unit * 4.2, unit * 3.6 * k, t.light ? "#3A4A66" : shade(t.color, -0.35));

        // 吉祥物：輪流揮手，才不會四隻一起動得像機器人
        const waving = Math.floor(now / 1800) % 4 === i;
        pikmin(g, x + cw / 2, top + ch * 0.78, Math.min(ch * 0.58, cw * 1.05), id, {
          t: now, phase: i * 0.7, wave: waving, face: i < 2 ? 1 : -1,
        });

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
        const size = unit * 9 * depth * (many ? 0.8 : 1);
        const px = wk.x * w;
        const py = wk.y * h;
        const age = now - wk.born;

        g.save();
        if (age < SPROUT_MS) {
          // 從土裡冒出來：只畫地面以上的部分，整隻慢慢往上長
          const k = age / SPROUT_MS;
          g.beginPath();
          g.rect(px - size, py - size * 2, size * 2, size * 2);
          g.clip();
          g.fillStyle = "#6B4424";
          g.beginPath();
          g.ellipse(px, py, size * 0.28, size * 0.07, 0, 0, Math.PI * 2);
          g.fill();
          pikmin(g, px, py + size * (1 - k), size, wk.team, { t: now, phase: wk.phase });
        } else {
          const walking = now >= wk.restUntil;
          pikmin(g, px, py, size, wk.team, {
            t: now, phase: wk.phase, walk: walking ? 0.6 : 0, face: wk.face,
          });
        }
        g.restore();

        // 名字。人一多就只寫前面那一排，不然整片都是字。
        if (!many || wk.y > 0.9) {
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
