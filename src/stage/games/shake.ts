/* ============================================================
   搖手機／拉手機三連發：拔河、賽跑、拔蘿蔔

   三個都吃同一種輸入：手機把「到目前為止總共動了幾下」放在 input.s 送上來，
   投影幕自己算差值。

   為什麼送累計值而不是「這次動了幾下」：
   input 會被伺服器攤平覆蓋，中間掉幾筆很正常。送增量的話掉一筆就
   少算幾下，玩家會覺得「我明明有搖」；送累計值的話掉多少筆都補得回來，
   下一筆一次把差額補上。

   延遲容忍度：極高。三個都是累加型的，單筆早到晚到 100ms 看不出來。
   ============================================================ */

import { TEAMS, TEAM_IDS, type TeamId } from "../../shared/teams";
import type { Game, GameContext } from "./types";

/**
 * 記住每個人上一次回報的累計數，算出這一幀新增了幾下。
 *
 * 中途加入的人第一筆會是一個沒看過的數字（他手機從 0 開始，但我們沒看過），
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

/** 各隊這一幀新增幾下、隊上幾個人。 */
function byTeam(
  ctx: GameContext,
  delta: Map<string, number>,
): Record<TeamId, { sum: number; size: number }> {
  const out = {} as Record<TeamId, { sum: number; size: number }>;
  for (const id of TEAM_IDS) out[id] = { sum: 0, size: 0 };
  for (const [uid, a] of ctx.field.actors) {
    const t = out[a.team];
    if (!t) continue;
    t.size++;
    t.sum += delta.get(uid) ?? 0;
  }
  return out;
}

/* ============================================================
   一、搖拔河 —— 兩場同時進行

   上半場 紅 vs 黃，下半場 綠 vs 藍。

   為什麼是兩場 1v1 而不是一場 2v2：每個人都要看得到「我這一隊」的繩子在哪，
   四隊擠一條繩子的話，紅隊的人根本分不出來是自己拉贏還是黃隊拉贏。
   ============================================================ */

/** 兩場對戰。[上半場, 下半場]，每一場是 [左, 右]。 */
const MATCHES: [TeamId, TeamId][] = [
  ["A", "B"],
  ["C", "D"],
];

export function createShakeTugGame(): Game {
  const meter = new ShakeMeter();
  /** 每一場的繩子位置，-1 = 左隊贏，+1 = 右隊贏 */
  let ropes = [0, 0];
  let winners: (TeamId | null)[] = [null, null];
  let running = false;
  /** 各隊這一局總共拉了幾下 */
  const pulls: Record<string, number> = {};

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
    ropes = [0, 0];
    winners = [null, null];
    running = false;
    for (const id of TEAM_IDS) pulls[id] = 0;
    meter.reset();
    ctx.field.reset(false);
    announce(ctx, "紅 vs 黃、綠 vs 藍，兩場同時比。等主持人喊開始");
  }

  return {
    id: "shaketug",
    title: "搖拔河",
    brief: "兩場同時比：上半場紅 vs 黃，下半場綠 vs 藍。搖一下拉一下。T 開始／暫停，R 重來。",

    enter: reset,

    step(_dt, _now, ctx) {
      if (!running) return;
      const teams = byTeam(ctx, meter.drain(ctx));
      for (const id of TEAM_IDS) pulls[id] = (pulls[id] ?? 0) + teams[id].sum;

      MATCHES.forEach((m, i) => {
        if (winners[i]) return;
        const [l, r] = m;
        // 人均而不是總和 —— 兩隊人數不一樣的時候，用總和就是人多的直接贏
        const per = (t: TeamId): number =>
          teams[t].size > 0 ? teams[t].sum / teams[t].size : 0;
        // 0.02 是手感係數：一個人狂搖約 8 下/秒，完全沒人擋的話約 6 秒拉完全場
        ropes[i] = Math.max(-1, Math.min(1, (ropes[i] ?? 0) + (per(r) - per(l)) * 0.02));

        if (Math.abs(ropes[i] ?? 0) >= 1) {
          winners[i] = (ropes[i] ?? 0) > 0 ? r : l;
        }
      });

      if (winners.every(Boolean)) {
        running = false;
        announce(
          ctx,
          `結束！${winners.map((t) => (t ? TEAMS[t].name : "")).join("、")}獲勝 🏆`,
        );
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;

      MATCHES.forEach((m, i) => {
        const [l, r] = m;
        const top = h * (i === 0 ? 0.08 : 0.54);
        const height = h * 0.38;
        const midY = top + height * 0.55;

        // 兩邊的底色
        g.save();
        g.globalAlpha = 0.13;
        g.fillStyle = TEAMS[l].color;
        g.fillRect(0, top, w / 2, height);
        g.fillStyle = TEAMS[r].color;
        g.fillRect(w / 2, top, w / 2, height);
        g.restore();

        // 中線與勝利線
        g.strokeStyle = "rgba(255,255,255,.22)";
        g.lineWidth = 2;
        for (const x of [w * 0.1, w / 2, w * 0.9]) {
          g.beginPath();
          g.moveTo(x, midY - unit * 5);
          g.lineTo(x, midY + unit * 5);
          g.stroke();
        }

        // 繩子
        g.strokeStyle = "#C9A227";
        g.lineWidth = unit * 1.2;
        g.beginPath();
        g.moveTo(w * 0.06, midY);
        g.lineTo(w * 0.94, midY);
        g.stroke();

        // 中心結
        const knotX = w / 2 + (ropes[i] ?? 0) * (w * 0.4);
        g.fillStyle = "#FFFFFF";
        g.beginPath();
        g.arc(knotX, midY, unit * 2.8, 0, Math.PI * 2);
        g.fill();

        // 隊名與拉的次數
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.font = `900 ${Math.round(unit * 4.5)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillStyle = TEAMS[l].color;
        g.fillText(TEAMS[l].name, w * 0.18, top + unit * 4);
        g.fillStyle = TEAMS[r].color;
        g.fillText(TEAMS[r].name, w * 0.82, top + unit * 4);

        g.font = `700 ${Math.round(unit * 2.6)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillStyle = "rgba(255,255,255,.75)";
        g.fillText(`${pulls[l] ?? 0} 下`, w * 0.18, top + unit * 8.5);
        g.fillText(`${pulls[r] ?? 0} 下`, w * 0.82, top + unit * 8.5);

        // 勝負
        const won = winners[i];
        if (won) {
          g.globalAlpha = 0.75 + 0.25 * Math.sin(now / 150);
          g.fillStyle = TEAMS[won].color;
          g.font = `900 ${Math.round(unit * 6)}px system-ui, "Noto Sans TC", sans-serif`;
          g.fillText(`${TEAMS[won].name} 獲勝`, w / 2, midY + unit * 9);
          g.globalAlpha = 1;
        }
      });

      if (!running && !winners.some(Boolean)) {
        g.textAlign = "center";
        g.fillStyle = "#FFFFFF";
        g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText("按 T 開始", w / 2, h * 0.5);
      }
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (winners.every(Boolean)) return true;
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
   二、搖賽跑 —— 團體賽

   同一隊所有人的次數累加起來推動同一個隊伍角色。
   一圈要幾下由主控台設定（Command k:"setting"）。

   預設 3000：一隊約 30 個人，一個人狂搖大約 4–5 下/秒，
   一隊就是每秒 130 下上下，一圈約 23 秒。兩圈約 45 秒 ——
   剛好是「喊得動但不會喊到沒力」的長度。

   ⚠️ 這裡用總和不是人均（這是刻意的，也是要求的玩法）：
   人多的隊就是佔便宜。所以畫面上會寫出每一隊幾個人，
   主持人看得到要不要調人或調一圈的下數。
   ============================================================ */
const LAPS = 2;

export function createShakeRunGame(): Game {
  const meter = new ShakeMeter();
  let running = false;
  let perLap = 3000;
  let finishedAt = 0;
  /** 每一隊累計的次數 */
  const total: Record<string, number> = {};
  let podium: TeamId[] = [];

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
    podium = [];
    for (const id of TEAM_IDS) total[id] = 0;
    meter.reset();
    ctx.field.reset(false);
    announce(ctx, `團體賽！全隊一起搖，跑 ${LAPS} 圈。等主持人喊開始`);
  }

  return {
    id: "shakerun",
    title: "搖賽跑",
    brief: `團體賽。全隊次數累加，跑 ${LAPS} 圈。`,

    enter: reset,

    step(_dt, now, ctx) {
      if (!running) return;
      const teams = byTeam(ctx, meter.drain(ctx));
      for (const id of TEAM_IDS) {
        total[id] = (total[id] ?? 0) + teams[id].sum;
        if ((total[id] ?? 0) >= perLap * LAPS && !podium.includes(id)) {
          podium.push(id);
          if (podium.length === 1) finishedAt = now;
          // 名次分數給全隊每一個人
          const pts = [100, 70, 50, 30][podium.length - 1] ?? 0;
          for (const a of ctx.field.actors.values()) {
            if (a.team === id) a.score += pts;
          }
        }
      }
      // 第一名進來之後再跑 15 秒就收，不然要等最後一隊
      if (finishedAt && now - finishedAt > 15_000) {
        running = false;
        announce(ctx, `比賽結束！${podium.map((t) => TEAMS[t].name).join(" > ")}`);
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const cx = w / 2;
      const cy = h * 0.5;
      const rx = w * 0.34;
      const ry = h * 0.32;

      // 跑道（橢圓），四條道
      for (let lane = 0; lane < 4; lane++) {
        const k = 0.76 + lane * 0.08;
        g.strokeStyle = "rgba(255,255,255,.12)";
        g.lineWidth = unit * 0.5;
        g.beginPath();
        g.ellipse(cx, cy, rx * k, ry * k, 0, 0, Math.PI * 2);
        g.stroke();
      }

      // 起／終點線
      g.strokeStyle = "#FFFFFF";
      g.lineWidth = unit * 0.7;
      g.beginPath();
      g.moveTo(cx, cy - ry * 1.08);
      g.lineTo(cx, cy - ry * 0.7);
      g.stroke();

      const sizes = byTeam(ctx, new Map());

      TEAM_IDS.forEach((id, i) => {
        const done = (total[id] ?? 0) / perLap; // 跑了幾圈
        const lane = 0.76 + i * 0.08;
        const ang = -Math.PI / 2 + (done % 1) * Math.PI * 2;
        const px = cx + Math.cos(ang) * rx * lane;
        const py = cy + Math.sin(ang) * ry * lane;

        g.fillStyle = TEAMS[id].color;
        g.beginPath();
        g.arc(px, py, unit * 3, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = "rgba(255,255,255,.7)";
        g.lineWidth = unit * 0.4;
        g.stroke();

        // 隊名寫在角色旁邊，一眼看得出誰是誰
        g.fillStyle = "#FFFFFF";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.font = `900 ${Math.round(unit * 2)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(TEAMS[id].name[0] ?? "", px, py);
      });

      // 中間：每隊進度 + 人數。人數要寫出來，因為這一關是比總和，人多佔便宜。
      g.textAlign = "left";
      g.textBaseline = "middle";
      TEAM_IDS.forEach((id, i) => {
        const y = cy - unit * 9 + i * unit * 6;
        const done = (total[id] ?? 0) / perLap;
        g.fillStyle = TEAMS[id].color;
        g.font = `900 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(`${TEAMS[id].name}`, cx - unit * 20, y);
        g.font = `700 ${Math.round(unit * 2.2)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillStyle = "rgba(255,255,255,.75)";
        g.fillText(`${sizes[id].size} 人`, cx - unit * 12, y);
        g.fillStyle = "#FFFFFF";
        g.font = `900 ${Math.round(unit * 2.6)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(`${done.toFixed(2)} / ${LAPS} 圈`, cx - unit * 5, y);
      });

      g.textAlign = "center";
      g.fillStyle = "rgba(255,255,255,.75)";
      g.font = `700 ${Math.round(unit * 2.2)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(`一圈 ${perLap} 下`, cx, cy + unit * 14);

      if (!running && podium.length === 0) {
        g.fillStyle = "#FFFFFF";
        g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText("按 T 開始", cx, cy + unit * 20);
      }

      if (podium.length > 0) {
        g.textAlign = "left";
        g.font = `900 ${Math.round(unit * 2.8)}px system-ui, "Noto Sans TC", sans-serif`;
        podium.forEach((id, i) => {
          g.fillStyle = ["#F2A72C", "#CFCFCF", "#C98B45", "#FFFFFF"][i] ?? "#FFF";
          g.fillText(`${i + 1}. ${TEAMS[id].name}`, unit * 3, unit * (12 + i * 4));
        });
      }
      void now;
    },

    /** 主控台可以調一圈要幾下。 */
    setting(key, value) {
      if (key === "perLap") perLap = Math.max(100, Math.round(value));
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        running = !running;
        if (running) meter.drain(ctx);
        announce(ctx, running ? "搖！全隊一起衝！" : "暫停");
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
   三、拔蘿蔔 —— 用拉的，不是用搖的

   手機平放，時間到往上一拉就拔起一根。拔到的蘿蔔會從地裡飛出去。

   為什麼改成拉：搖晃跟前面兩關是同一個動作，連三關都在甩手很膩；
   而且「拔蘿蔔」的體感本來就是往上拔，不是左右晃。
   ============================================================ */
const CARROT_MS = 60_000;
/** 拉幾下拔起一根。拉比搖慢得多，所以這個數字要小。 */
const PER_CARROT = 2;

interface FlyingCarrot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  born: number;
}

export function createShakeCarrotGame(): Game {
  const meter = new ShakeMeter();
  let running = false;
  let endsAt = 0;
  /** 每個人身上還沒湊滿一根的零頭 */
  const carry = new Map<string, number>();
  const carrots: Record<string, number> = {};
  /** 飛出去的蘿蔔。純視覺，不影響計分。 */
  let flying: FlyingCarrot[] = [];

  function announce(ctx: GameContext, hint: string): void {
    const teams: Record<string, { score: number }> = {};
    for (const id of TEAM_IDS) teams[id] = { score: carrots[id] ?? 0 };
    ctx.publish({
      phase: "playing",
      game: "shakecarrot",
      control: "shake",
      gesture: "lift",
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
    flying = [];
    for (const id of TEAM_IDS) carrots[id] = 0;
    meter.reset();
    ctx.field.reset(false);
    announce(ctx, "一分鐘，把手機往上拉就拔一根。哪一隊拔最多？");
  }

  /** 從某一隊的田裡噴一根蘿蔔出來。 */
  function spawn(teamIndex: number, now: number): void {
    // 太多顆會拖慢投影幕，而且畫面會糊成一團
    if (flying.length > 80) return;
    flying.push({
      x: 0.125 + teamIndex * 0.25 + (Math.random() - 0.5) * 0.12,
      y: 0.78,
      vx: (Math.random() - 0.5) * 0.5,
      vy: -1.1 - Math.random() * 0.5,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 8,
      born: now,
    });
  }

  return {
    id: "shakecarrot",
    title: "拔蘿蔔",
    brief: "分組對抗。一分鐘內把手機往上拉就拔一根，哪一隊拔最多。",

    enter: reset,

    step(dt, now, ctx) {
      // 動畫不管有沒有在比都要跑完，不然時間到畫面會卡住一堆蘿蔔
      for (const c of flying) {
        c.vy += 2.4 * dt; // 重力
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.rot += c.spin * dt;
      }
      flying = flying.filter((c) => now - c.born < 2500 && c.y < 1.3);

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
        const acc = (carry.get(uid) ?? 0) + n;
        const pulled = Math.floor(acc / PER_CARROT);
        carry.set(uid, acc % PER_CARROT);
        if (pulled > 0) {
          carrots[actor.team] = (carrots[actor.team] ?? 0) + pulled;
          actor.score += pulled;
          // 每拔一根噴一顆出來，最多一次噴 3 顆（狂拉的人不要洗版）
          const ti = TEAM_IDS.indexOf(actor.team);
          for (let k = 0; k < Math.min(3, pulled); k++) spawn(ti, now);
        }
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      const left = running ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 0;

      // 泥土地
      g.fillStyle = "#3A2A1C";
      g.fillRect(0, h * 0.78, w, h * 0.22);

      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 8)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(running ? `${left}` : "按 T 開始", w / 2, unit * 10);

      // 四隊的田
      const colW = w / 4;
      TEAM_IDS.forEach((id, i) => {
        const n = carrots[id] ?? 0;
        const cx = colW * i + colW / 2;

        g.fillStyle = TEAMS[id].color;
        g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(TEAMS[id].name, cx, h * 0.9);
        g.fillStyle = "#FFFFFF";
        g.font = `900 ${Math.round(unit * 7)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(String(n), cx, h * 0.96);

        // 地裡還沒拔的蘿蔔葉子
        g.font = `${Math.round(unit * 3)}px system-ui, sans-serif`;
        for (let k = 0; k < 6; k++) {
          g.fillText("🌱", cx - unit * 7 + k * unit * 2.8, h * 0.8);
        }
      });

      // 飛出去的蘿蔔
      g.font = `${Math.round(unit * 5)}px system-ui, sans-serif`;
      for (const c of flying) {
        const age = (now - c.born) / 2500;
        g.save();
        g.globalAlpha = Math.max(0, 1 - age * age);
        g.translate(c.x * w, c.y * h);
        g.rotate(c.rot);
        g.fillText("🥕", 0, 0);
        g.restore();
      }
      g.globalAlpha = 1;
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (!running) {
          running = true;
          endsAt = performance.now() + CARROT_MS;
          meter.drain(ctx);
          announce(ctx, "拉！把蘿蔔拔起來！");
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
