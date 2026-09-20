/* ============================================================
   搖手機三連發：拔河、賽跑、拔蘿蔔

   三個都吃同一種輸入：手機把「到目前為止總共搖了幾下」放在 input.s 送上來，
   投影幕自己算差值。

   為什麼送累計值而不是「這次搖了幾下」：
   input 會被伺服器攤平覆蓋，中間掉幾筆很正常。送增量的話掉一筆就
   少算幾下，玩家會覺得「我明明有搖」；送累計值的話掉多少筆都補得回來，
   下一筆一次把差額補上。

   延遲容忍度：極高。三個都是累加型的，單筆早到晚到 100ms 看不出來。
   ============================================================ */

import { TEAMS, TEAM_IDS, type TeamId } from "../../shared/teams";
import type { Game, GameContext } from "./types";

/** 拔河分成兩邊：紅黃 vs 綠藍。 */
const LEFT: TeamId[] = ["A", "B"];

/**
 * 記住每個人上一次回報的累計搖動數，算出這一幀新增了幾下。
 *
 * 中途加入的人第一筆會是一個很大的數字（他手機從 0 開始，但我們沒看過），
 * 所以第一次看到某個 uid 時只記錄、不計分，避免他一進場就爆分。
 */
class ShakeMeter {
  private readonly last = new Map<string, number>();

  reset(): void {
    this.last.clear();
  }

  /** @returns 這一幀每個人新增幾下 */
  drain(ctx: GameContext): Map<string, number> {
    const out = new Map<string, number>();
    for (const [uid, a] of ctx.field.actors) {
      const now = a.shakes;
      const prev = this.last.get(uid);
      this.last.set(uid, now);
      if (prev === undefined) continue; // 第一次看到，只記錄
      const delta = now - prev;
      // 手機重整會讓計數歸零，delta 變負數。當成 0，不要倒扣。
      if (delta > 0) out.set(uid, delta);
    }
    return out;
  }
}

/* ============================================================
   一、搖拔河
   ============================================================ */
export function createShakeTugGame(): Game {
  const meter = new ShakeMeter();
  /** 繩子位置，-1 = 左邊贏，+1 = 右邊贏 */
  let rope = 0;
  let running = false;
  let winner: "left" | "right" | null = null;
  /** 這一局各邊搖了幾下，畫面上要看得到 */
  let pulls = { left: 0, right: 0 };

  function sideOf(team: TeamId): "left" | "right" {
    return LEFT.includes(team) ? "left" : "right";
  }

  function announce(ctx: GameContext, hint: string): void {
    ctx.publish({
      phase: "playing",
      game: "shaketug",
      control: "shake",
      round: 1,
      accepting: running,
      hint,
      options: [],
    });
  }

  function reset(ctx: GameContext): void {
    rope = 0;
    winner = null;
    running = false;
    pulls = { left: 0, right: 0 };
    meter.reset();
    ctx.field.reset(false);
    announce(ctx, "紅黃 vs 綠藍。等主持人喊開始，然後用力搖！");
  }

  return {
    id: "shaketug",
    title: "搖拔河",
    brief: "紅黃 vs 綠藍。搖一下拉一下。T 開始／暫停，R 重來。",

    enter: reset,

    step(_dt, _now, ctx) {
      if (!running || winner) return;
      const delta = meter.drain(ctx);

      // 每一邊的「人均搖動數」，不是總和 ——
      // 兩邊人數不一樣的時候，用總和就是人多的直接贏。
      const sum = { left: 0, right: 0 };
      const size = { left: 0, right: 0 };
      for (const [uid, a] of ctx.field.actors) {
        const side = sideOf(a.team);
        size[side]++;
        sum[side] += delta.get(uid) ?? 0;
      }
      pulls.left += sum.left;
      pulls.right += sum.right;

      const per = {
        left: size.left > 0 ? sum.left / size.left : 0,
        right: size.right > 0 ? sum.right / size.right : 0,
      };
      // 0.02 是手感係數：一個人狂搖大約 8 下/秒，兩邊完全沒人擋的話
      // 約 6 秒拉完全場。要更快就調大。
      rope += (per.right - per.left) * 0.02;
      rope = Math.max(-1, Math.min(1, rope));

      if (Math.abs(rope) >= 1) {
        winner = rope > 0 ? "right" : "left";
        running = false;
        announce(ctx, winner === "left" ? "紅黃隊獲勝！🏆" : "綠藍隊獲勝！🏆");
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const midY = h * 0.45;

      // 兩邊的底色
      g.save();
      g.globalAlpha = 0.14;
      g.fillStyle = TEAMS.A.color;
      g.fillRect(0, 0, w / 2, h);
      g.fillStyle = TEAMS.C.color;
      g.fillRect(w / 2, 0, w / 2, h);
      g.restore();

      // 中線與勝利線
      g.strokeStyle = "rgba(255,255,255,.2)";
      g.lineWidth = 2;
      for (const x of [w * 0.1, w / 2, w * 0.9]) {
        g.beginPath();
        g.moveTo(x, midY - unit * 14);
        g.lineTo(x, midY + unit * 14);
        g.stroke();
      }

      // 繩子
      const knotX = w / 2 + rope * (w * 0.4);
      g.strokeStyle = "#C9A227";
      g.lineWidth = unit * 1.2;
      g.beginPath();
      g.moveTo(w * 0.06, midY);
      g.lineTo(w * 0.94, midY);
      g.stroke();

      // 中心結
      g.fillStyle = "#FFFFFF";
      g.beginPath();
      g.arc(knotX, midY, unit * 3.2, 0, Math.PI * 2);
      g.fill();

      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `900 ${Math.round(unit * 5)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillStyle = TEAMS.A.color;
      g.fillText("紅黃隊", w * 0.2, midY - unit * 20);
      g.fillStyle = TEAMS.C.color;
      g.fillText("綠藍隊", w * 0.8, midY - unit * 20);

      g.font = `700 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillStyle = "rgba(255,255,255,.8)";
      g.fillText(`${pulls.left} 下`, w * 0.2, midY - unit * 14);
      g.fillText(`${pulls.right} 下`, w * 0.8, midY - unit * 14);

      g.fillStyle = "#FFFFFF";
      if (winner) {
        g.globalAlpha = 0.7 + 0.3 * Math.sin(now / 150);
        g.font = `900 ${Math.round(unit * 9)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(winner === "left" ? "紅黃隊獲勝" : "綠藍隊獲勝", w / 2, h * 0.75);
        g.globalAlpha = 1;
      } else if (!running) {
        g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText("按 T 開始", w / 2, h * 0.75);
      }
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (winner) return true;
        running = !running;
        // 開始的瞬間重抓基準，不然暫停期間搖的會一次灌進來
        if (running) meter.drain(ctx);
        announce(ctx, running ? "搖！用力搖！" : "暫停");
        return true;
      }
      if (e.key === "r" || e.key === "R") {
        reset(ctx);
        return true;
      }
      return false;
    },
  };
}

/* ============================================================
   二、搖賽跑
   ============================================================ */
const LAPS = 2;

export function createShakeRunGame(): Game {
  const meter = new ShakeMeter();
  let running = false;
  let finishedAt = 0;
  /** 每個人跑了多遠（圈數，可以超過 1） */
  const dist = new Map<string, number>();
  let podium: string[] = [];

  function announce(ctx: GameContext, hint: string): void {
    ctx.publish({
      phase: "playing",
      game: "shakerun",
      control: "shake",
      round: 1,
      accepting: running,
      hint,
      options: [],
    });
  }

  function reset(ctx: GameContext): void {
    running = false;
    finishedAt = 0;
    dist.clear();
    podium = [];
    meter.reset();
    ctx.field.reset(false);
    announce(ctx, `搖手機前進，跑 ${LAPS} 圈。等主持人喊開始`);
  }

  return {
    id: "shakerun",
    title: "搖賽跑",
    brief: `個人賽。搖一下前進一點，跑 ${LAPS} 圈。T 開始／暫停，R 重來。`,

    enter: reset,

    step(_dt, now, ctx) {
      if (!running) return;
      const delta = meter.drain(ctx);
      for (const [uid, n] of delta) {
        // 一下大約 0.5% 圈，狂搖 8 下/秒的人約 25 秒一圈
        const next = (dist.get(uid) ?? 0) + n * 0.005;
        dist.set(uid, next);
        if (next >= LAPS && !podium.includes(uid)) {
          podium.push(uid);
          const actor = ctx.field.actors.get(uid);
          // 前三名才有分，不然全場都跑完就沒有差別了
          if (actor && podium.length <= 3) {
            actor.score += [100, 70, 50][podium.length - 1] ?? 0;
          }
          if (podium.length === 1) finishedAt = now;
        }
      }
      // 第一名進來之後再跑 10 秒就收，不然要等最後一名
      if (finishedAt && now - finishedAt > 10_000) {
        running = false;
        announce(ctx, "比賽結束！");
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const cx = w / 2;
      const cy = h * 0.47;
      const rx = w * 0.36;
      const ry = h * 0.3;

      // 跑道（橢圓）
      for (const [r, style] of [
        [1.0, "rgba(255,255,255,.18)"],
        [0.82, "rgba(255,255,255,.12)"],
      ] as const) {
        g.strokeStyle = style;
        g.lineWidth = unit * 0.6;
        g.beginPath();
        g.ellipse(cx, cy, rx * r, ry * r, 0, 0, Math.PI * 2);
        g.stroke();
      }

      // 起／終點線
      g.strokeStyle = "#FFFFFF";
      g.lineWidth = unit * 0.8;
      g.beginPath();
      g.moveTo(cx, cy - ry * 1.05);
      g.lineTo(cx, cy - ry * 0.78);
      g.stroke();

      // 每個人一個點，沿著橢圓跑
      const dotR = Math.max(unit * 0.9, Math.min(unit * 1.6, (unit * 60) / Math.max(20, ctx.field.actors.size)));
      for (const [uid, a] of ctx.field.actors) {
        const d = dist.get(uid) ?? 0;
        // -PI/2 起跑（正上方），順時針跑
        const ang = -Math.PI / 2 + (d % 1) * Math.PI * 2;
        // 內外道錯開，一百個人才不會疊成一條線
        const lane = 0.82 + ((hash(uid) % 100) / 100) * 0.18;
        const px = cx + Math.cos(ang) * rx * lane;
        const py = cy + Math.sin(ang) * ry * lane;
        g.fillStyle = TEAMS[a.team].color;
        g.beginPath();
        g.arc(px, py, dotR, 0, Math.PI * 2);
        g.fill();
      }

      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(running ? `跑 ${LAPS} 圈` : "按 T 開始", cx, cy);

      // 名次
      if (podium.length > 0) {
        g.textAlign = "left";
        g.font = `900 ${Math.round(unit * 2.6)}px system-ui, "Noto Sans TC", sans-serif`;
        podium.slice(0, 3).forEach((uid, i) => {
          const a = ctx.field.actors.get(uid);
          g.fillStyle = ["#F2A72C", "#CFCFCF", "#C98B45"][i] ?? "#FFF";
          g.fillText(`${i + 1}. ${a?.name ?? ""}`, unit * 3, unit * (10 + i * 4));
        });
      }
      void now;
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        running = !running;
        if (running) meter.drain(ctx);
        announce(ctx, running ? "搖！衝啊！" : "暫停");
        return true;
      }
      if (e.key === "r" || e.key === "R") {
        reset(ctx);
        return true;
      }
      return false;
    },
  };
}

/* ============================================================
   三、拔蘿蔔
   ============================================================ */
const CARROT_MS = 60_000;
/** 搖幾下拔起一根 */
const PER_CARROT = 6;

export function createShakeCarrotGame(): Game {
  const meter = new ShakeMeter();
  let running = false;
  let endsAt = 0;
  /** 每個人身上還沒湊滿一根的零頭 */
  const carry = new Map<string, number>();
  const carrots: Record<string, number> = {};

  function announce(ctx: GameContext, hint: string): void {
    const teams: Record<string, { score: number }> = {};
    for (const id of TEAM_IDS) teams[id] = { score: carrots[id] ?? 0 };
    ctx.publish({
      phase: "playing",
      game: "shakecarrot",
      control: "shake",
      round: 1,
      accepting: running,
      teams,
      hint,
      options: [],
    });
  }

  function reset(ctx: GameContext): void {
    running = false;
    carry.clear();
    for (const id of TEAM_IDS) carrots[id] = 0;
    meter.reset();
    ctx.field.reset(false);
    announce(ctx, "一分鐘，哪一隊拔最多蘿蔔。等主持人喊開始");
  }

  return {
    id: "shakecarrot",
    title: "拔蘿蔔",
    brief: "分組對抗。一分鐘內搖手機拔蘿蔔，哪一隊拔最多。T 開始，R 重來。",

    enter: reset,

    step(_dt, now, ctx) {
      if (!running) return;
      if (now >= endsAt) {
        running = false;
        const best = TEAM_IDS.reduce((a, b) => ((carrots[a] ?? 0) >= (carrots[b] ?? 0) ? a : b));
        announce(ctx, `時間到！${TEAMS[best].name}拔了 ${carrots[best] ?? 0} 根 🥕`);
        return;
      }
      const delta = meter.drain(ctx);
      for (const [uid, n] of delta) {
        const actor = ctx.field.actors.get(uid);
        if (!actor) continue;
        const total = (carry.get(uid) ?? 0) + n;
        const pulled = Math.floor(total / PER_CARROT);
        carry.set(uid, total % PER_CARROT);
        if (pulled > 0) {
          carrots[actor.team] = (carrots[actor.team] ?? 0) + pulled;
          actor.score += pulled;
        }
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const left = running ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 0;

      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 8)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(running ? `${left}` : "按 T 開始", w / 2, unit * 12);

      // 四隊各一欄，蘿蔔用 emoji 疊上去，滿了就只寫數字
      const colW = w / 4;
      TEAM_IDS.forEach((id, i) => {
        const n = carrots[id] ?? 0;
        const cx = colW * i + colW / 2;
        const baseY = h - unit * 10;

        g.fillStyle = TEAMS[id].color;
        g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(TEAMS[id].name, cx, h - unit * 5);
        g.font = `900 ${Math.round(unit * 7)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillStyle = "#FFFFFF";
        g.fillText(String(n), cx, baseY - unit * 2);

        // 一根 emoji 代表 5 根，最多畫 40 個，不然一百多根會畫爆
        const icons = Math.min(40, Math.floor(n / 5));
        g.font = `${Math.round(unit * 2.4)}px system-ui, sans-serif`;
        for (let k = 0; k < icons; k++) {
          const col = k % 8;
          const row = Math.floor(k / 8);
          g.fillText("🥕", cx - unit * 8.4 + col * unit * 2.4, baseY - unit * 8 - row * unit * 2.6);
        }
      });
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (!running) {
          running = true;
          endsAt = performance.now() + CARROT_MS;
          meter.drain(ctx);
          announce(ctx, "搖！拔蘿蔔！");
        } else {
          running = false;
          announce(ctx, "暫停");
        }
        return true;
      }
      if (e.key === "r" || e.key === "R") {
        reset(ctx);
        return true;
      }
      return false;
    },
  };
}

/** 給跑道分內外道用的穩定亂數 */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
