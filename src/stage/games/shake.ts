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
import { PER_CARROT } from "../../shared/rules";
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
   一、熱血拔河 —— 兩場同時進行

   上半場 火象 vs 水象，下半場 土象 vs 風象。

   為什麼是兩場 1v1 而不是一場 2v2：每個人都要看得到「我這一隊」的繩子在哪，
   四隊擠一條繩子的話，火象的人根本分不出來是自己拉贏還是水象拉贏。

   動作是「用手指往下滑」不是搖手機：拔河的體感本來就是往自己這邊拉，
   那是一個有方向的動作。而且滑動不吃感測器權限 ——
   沒給權限、或手機根本沒有加速度計的人，這一關不會整場動不了。
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
      // 一定要寫出來。省略的話會沿用上一關留在 state 裡的值 ——
      // 玩過拔蘿蔔再回來，手機會叫大家「把手機往上拉」。
      gesture: "swipe",
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
    announce(ctx, `${TEAMS.A.name} vs ${TEAMS.B.name}、${TEAMS.C.name} vs ${TEAMS.D.name}，兩場同時比。等主持人喊開始`);
  }

  return {
    id: "shaketug",
    title: "熱血拔河",
    brief: `兩場同時比：上半場${TEAMS.A.name} vs ${TEAMS.B.name}，下半場${TEAMS.C.name} vs ${TEAMS.D.name}。手指往下滑一次拉一下。T 開始／暫停，R 重來。`,

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
        /* 0.05 是手感係數。滑比搖慢得多（一個人拚命滑約 3 下/秒，
           搖可以到 8 下/秒），所以係數要跟著放大，不然一場拔河要拉兩分鐘。
           完全沒人擋的話約 7 秒拉完全場。 */
        ropes[i] = Math.max(-1, Math.min(1, (ropes[i] ?? 0) + (per(r) - per(l)) * 0.05));

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
        g.fillText("準備中", w / 2, h * 0.5);
      }
    },

    running: () => running,

    run(on, ctx) {
      if (winners.every(Boolean)) return false;
      if (running === on) return true;
      running = on;
      // 開始的瞬間重抓基準，不然暫停期間搖的會一次灌進來
      if (on) meter.drain(ctx);
      announce(ctx, on ? "往下滑！用力拉過來！" : "暫停");
      return true;
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (winners.every(Boolean)) return true;
        running = !running;
        // 開始的瞬間重抓基準，不然暫停期間搖的會一次灌進來
        if (running) meter.drain(ctx);
        announce(ctx, running ? "往下滑！用力拉過來！" : "暫停");
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
   二、熱血賽跑 —— 團體賽

   由左跑到右，全程 N 步。同一隊所有人搖的次數累加起來推動同一個角色。
   一搖一步，全程幾步由主控台設定（Command k:"setting"）。

   為什麼是直線不是跑道：橢圓跑道要用「跑了幾圈」表示進度，
   而圈數是一個換算過的數字 —— 手機上寫 5、投影幕上寫 0.03 圈，
   兩邊講的不是同一件事。直線的話「還差多少」用看的就知道，
   而且四隊誰在前面一眼分得出來，不用去數誰超過誰一圈。

   預設 6000 步：一隊約 30 個人，一個人狂搖大約 4–5 下/秒，
   一隊就是每秒 130 步上下，全程約 45 秒 ——
   剛好是「喊得動但不會喊到沒力」的長度。

   ⚠️ 這裡用總和不是人均（這是刻意的，也是要求的玩法）：
   人多的隊就是佔便宜。主控台看得到各隊人數，
   要調人或調全程步數都在那裡。
   ============================================================ */

/**
 * 限時一分鐘。
 *
 * 沒有時限的話，人少的那一隊可能要跑三分鐘才到終點，而全場已經看完了 ——
 * 現場最怕的就是這種「還沒結束但大家已經不看了」的尾巴。
 * 時間到還沒有人到終點就比步數，總之一分鐘一定收得掉。
 */
const RUN_MS = 60_000;

export function createShakeRunGame(): Game {
  const meter = new ShakeMeter();
  let running = false;
  /** 全程幾步。主控台可調。 */
  let goalSteps = 6000;
  let finishedAt = 0;
  /** 這一局結束的時刻（performance.now()）。 */
  let endsAt = 0;
  /** 暫停時還剩多少毫秒。回來從這裡接著跑。 */
  let left = RUN_MS;
  /** 時間到了沒 */
  let timeUp = false;
  /** 每一隊跑了幾步 */
  const total: Record<string, number> = {};
  let podium: TeamId[] = [];

  /** 給名次分數。第一到第四：100 / 70 / 50 / 30。 */
  function award(ctx: GameContext, id: TeamId): void {
    const pts = [100, 70, 50, 30][podium.length - 1] ?? 0;
    for (const a of ctx.field.actors.values()) {
      if (a.team === id) a.score += pts;
    }
  }

  function announce(ctx: GameContext, hint: string): void {
    ctx.publish({
      phase: "playing",
      game: "shakerun",
      control: "shake",
      // 一定要寫出來。省略的話會沿用上一關留在 state 裡的值 ——
      // 玩過拔蘿蔔再回來，手機會叫大家「把手機往上拉」。
      gesture: "shake",
      round: 1,
      accepting: running,
      hint,
      options: [],
    });
  }

  function reset(ctx: GameContext): void {
    running = false;
    finishedAt = 0;
    left = RUN_MS;
    timeUp = false;
    podium = [];
    for (const id of TEAM_IDS) total[id] = 0;
    meter.reset();
    ctx.field.reset(false);
    announce(ctx, `團體賽！全隊一起搖，一搖一步，限時一分鐘跑完 ${goalSteps} 步。等主持人喊開始`);
  }

  /** 時間到：還沒到終點的隊伍按步數多寡排進名次。 */
  function finishOnTime(ctx: GameContext): void {
    running = false;
    timeUp = true;
    const rest = TEAM_IDS.filter((id) => !podium.includes(id)).sort(
      (a, b) => (total[b] ?? 0) - (total[a] ?? 0),
    );
    for (const id of rest) {
      podium.push(id);
      award(ctx, id);
    }
    announce(ctx, `時間到！${podium.map((t) => TEAMS[t].name).join(" > ")}`);
  }

  return {
    id: "shakerun",
    title: "熱血賽跑",
    brief: "團體賽。全隊次數累加，一搖一步，由左跑到右。",

    enter: reset,

    step(_dt, now, ctx) {
      if (!running) return;
      const teams = byTeam(ctx, meter.drain(ctx));
      for (const id of TEAM_IDS) {
        total[id] = (total[id] ?? 0) + teams[id].sum;
        if ((total[id] ?? 0) >= goalSteps && !podium.includes(id)) {
          podium.push(id);
          if (podium.length === 1) finishedAt = now;
          award(ctx, id); // 名次分數給全隊每一個人
        }
      }

      // 四隊都到終點就不用再等了
      if (podium.length === TEAM_IDS.length) {
        running = false;
        announce(ctx, `比賽結束！${podium.map((t) => TEAMS[t].name).join(" > ")}`);
        return;
      }

      // 時間到：剩下的隊伍比步數
      if (now >= endsAt) {
        finishOnTime(ctx);
        return;
      }

      // 第一名進來之後再跑 15 秒就收，不然要等最後一隊
      if (finishedAt && now - finishedAt > 15_000) {
        finishOnTime(ctx);
      }
    },

    draw(now, ctx) {
      const { ctx: g, w, h, unit } = ctx.surface;
      /* 左邊留一塊寫隊名和步數，右邊留一塊給終點線。
         角色從 startX 跑到 endX，不繞圈 —— 位置本身就是進度。 */
      const startX = w * 0.26;
      // 終點留在 QR 左邊。QR 在右上角，跑到 0.9 的話終點線會被它蓋住。
      const endX = w * 0.82;
      const laneH = h * 0.13;
      const top = h * 0.22;
      const bottom = top + laneH * 4;

      g.textBaseline = "middle";

      TEAM_IDS.forEach((id, i) => {
        const y = top + laneH * i + laneH / 2;
        const steps = total[id] ?? 0;
        const done = Math.min(1, steps / goalSteps);
        const px = startX + (endX - startX) * done;

        // 跑道
        g.strokeStyle = "rgba(255,255,255,.10)";
        g.lineWidth = laneH * 0.8;
        g.beginPath();
        g.moveTo(startX, y);
        g.lineTo(endX, y);
        g.stroke();

        // 已經跑過的那一段染成隊色，遠遠看就是一條進度條
        g.strokeStyle = TEAMS[id].color;
        g.globalAlpha = 0.3;
        g.lineWidth = laneH * 0.8;
        g.beginPath();
        g.moveTo(startX, y);
        g.lineTo(Math.max(startX + 0.1, px), y);
        g.stroke();
        g.globalAlpha = 1;

        /* 隊名與步數都放在起點線左邊。
           步數不能貼著起點線 —— 還沒起跑時角色就停在那裡，
           數字會整個被角色蓋掉（第一版就是這樣，畫面上看不到 0）。 */
        g.textAlign = "right";
        g.fillStyle = TEAMS[id].color;
        g.font = `900 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(TEAMS[id].name, startX - unit * 12, y);
        g.fillStyle = "#FFFFFF";
        g.font = `900 ${Math.round(unit * 2.8)}px system-ui, "Noto Sans TC", sans-serif`;
        // 就是手機上那個數字的隊伍加總，沒有換算
        g.fillText(`${steps}`, startX - unit * 5, y);

        // 角色
        g.fillStyle = TEAMS[id].color;
        g.beginPath();
        g.arc(px, y, unit * 3, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = "rgba(255,255,255,.7)";
        g.lineWidth = unit * 0.4;
        g.stroke();

        // 用 ink 不是白色 —— 風象的角色是白的，白字寫上去整個看不見
        g.fillStyle = TEAMS[id].ink;
        g.textAlign = "center";
        g.font = `900 ${Math.round(unit * 2)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(TEAMS[id].name[0] ?? "", px, y);
      });

      // 起點線與終點線
      g.strokeStyle = "rgba(255,255,255,.35)";
      g.lineWidth = unit * 0.5;
      g.beginPath();
      g.moveTo(startX, top);
      g.lineTo(startX, bottom);
      g.stroke();

      g.strokeStyle = "#FFFFFF";
      g.lineWidth = unit * 0.8;
      g.beginPath();
      g.moveTo(endX, top);
      g.lineTo(endX, bottom);
      g.stroke();
      // 終點兩個字放在線的下面。放上面會被右上角的 QR 蓋掉。
      g.textAlign = "center";
      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 2.4)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText("終點", endX, bottom + unit * 3);

      g.fillStyle = "rgba(255,255,255,.75)";
      g.font = `700 ${Math.round(unit * 2.2)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(`全程 ${goalSteps} 步　一搖一步`, w / 2, bottom + unit * 3);

      // 倒數秒數放在跑道上方正中間，遠遠就看得到還剩多久
      const secs = running ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : Math.ceil(left / 1000);
      g.textAlign = "center";
      g.fillStyle = secs <= 10 && running ? "#F2A72C" : "#FFFFFF";
      g.font = `900 ${Math.round(unit * 7)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(running ? `${secs}` : timeUp ? "時間到" : "準備中", w / 2, top - unit * 7);

      /* 名次排在跑道下面，不要貼左上角。
         左上角有 HUD 的「N 人已加入」和關卡標題，名次畫上去會疊在一起 ——
         而名次正是這一關結束時全場唯一要看的東西。 */
      if (podium.length > 0) {
        g.textAlign = "center";
        g.font = `900 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
        const gap = w * 0.16;
        const x0 = w / 2 - (gap * (podium.length - 1)) / 2;
        podium.forEach((id, i) => {
          g.fillStyle = ["#F2A72C", "#CFCFCF", "#C98B45", "#FFFFFF"][i] ?? "#FFF";
          g.fillText(`${i + 1}. ${TEAMS[id].name}`, x0 + gap * i, bottom + unit * 9);
        });
      }
    },

    /** 主控台可以調全程要幾步。 */
    setting(key, value) {
      if (key === "runSteps") goalSteps = Math.max(100, Math.round(value));
    },

    running: () => running,

    run(on, ctx) {
      if (timeUp) return false; // 已經比完了，再開始沒有意義
      if (running === on) return true;
      running = on;
      if (on) {
        // 暫停過就從剩下的時間接著跑，不要重新給滿一分鐘
        endsAt = performance.now() + left;
        meter.drain(ctx);
      } else {
        left = Math.max(0, endsAt - performance.now());
      }
      announce(ctx, on ? "搖！全隊一起衝！" : "暫停");
      return true;
    },

    key(e, ctx) {
      // T 走跟主控台同一條路，才不會有兩套開始／暫停的邏輯要對
      if (e.key === "t" || e.key === "T") {
        this.run?.(!running, ctx);
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

   手機平放，往上拉 10 下拔起一根。這 10 下之間蘿蔔會從土裡慢慢冒出來
   （那個進度在手機上看得到），拔滿了就從地裡飛出去，然後換下一根。

   為什麼改成拉：搖晃跟前面兩關是同一個動作，連三關都在甩手很膩；
   而且「拔蘿蔔」的體感本來就是往上拔，不是左右晃。

   為什麼一根要 10 下而不是 1 下：一拉一根的話，一分鐘會拔出好幾百根，
   數字大到沒有感覺，而且「拔」這個動作變成純計數。要拉 10 下才起來，
   每一根都有一個從卡住到鬆動到拔出來的過程。
   ============================================================ */
const CARROT_MS = 60_000;

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
  /** 暫停時剩下多少毫秒。回來的時候從這裡接著跑。 */
  let left = CARROT_MS;
  /** 每個人身上還沒湊滿一根的零頭 */
  const carry = new Map<string, number>();
  const carrots: Record<string, number> = {};
  /** 飛出去的蘿蔔。純視覺，不影響計分。 */
  let flying: FlyingCarrot[] = [];

  /** 這一隊離下一輪蘿蔔還有多遠，0..1。純視覺。 */
  function progressOf(ctx: GameContext, team: TeamId): number {
    let sum = 0;
    let size = 0;
    for (const [uid, a] of ctx.field.actors) {
      if (a.team !== team) continue;
      size++;
      sum += carry.get(uid) ?? 0;
    }
    if (size === 0) return 0;
    return Math.min(1, sum / (size * PER_CARROT));
  }

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
    left = CARROT_MS;
    carry.clear();
    flying = [];
    for (const id of TEAM_IDS) carrots[id] = 0;
    meter.reset();
    ctx.field.reset(false);
    announce(ctx, "一分鐘，把手機往上拉，拉 10 下拔起一根。哪一隊拔最多？");
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
    brief: "分組對抗。一分鐘內把手機往上拉，拉 10 下一根，哪一隊拔最多。",

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
      let gained = false;
      for (const [uid, n] of delta) {
        const actor = ctx.field.actors.get(uid);
        if (!actor) continue;
        const acc = (carry.get(uid) ?? 0) + n;
        const pulled = Math.floor(acc / PER_CARROT);
        carry.set(uid, acc % PER_CARROT);
        if (pulled > 0) {
          carrots[actor.team] = (carrots[actor.team] ?? 0) + pulled;
          actor.score += pulled;
          gained = true;
          // 每拔一根噴一顆出來，最多一次噴 3 顆（狂拉的人不要洗版）
          const ti = TEAM_IDS.indexOf(actor.team);
          for (let k = 0; k < Math.min(3, pulled); k++) spawn(ti, now);
        }
      }

      /* 拔到了就把各隊的數字重送一次。
         原本只在開始和結束 announce，中間 carrots 一直在變卻沒人送出去 ——
         投影幕是自己從記憶體畫的所以看得到，但手機端的 teams 整場都停在 0，
         玩家拉了半天看不到自己這一隊有沒有前進。
         publishState 會過濾掉沒變的欄位，而且節流在 10 Hz，所以這樣不會洗版。 */
      if (gained) announce(ctx, "拉！把蘿蔔拔起來！");
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
      g.fillText(running ? `${left}` : "準備中", w / 2, unit * 10);

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

        /* 正在拔的那一根：從土裡冒出來的高度 = 這一隊的平均進度。
           用平均而不是總和 —— 總和除以 10 取餘數的話，三十個人一起拉
           會讓它每秒轉好幾圈，看起來只是雜訊。平均的意思是
           「這一隊離下一輪蘿蔔還有多遠」，動得慢但是看得懂。 */
        const soil = h * 0.78;
        const rise = progressOf(ctx, id);
        g.save();
        // 只畫土面以上的部分，蘿蔔才像是從土裡長出來的
        g.beginPath();
        g.rect(0, 0, w, soil);
        g.clip();
        g.font = `${Math.round(unit * 6)}px system-ui, sans-serif`;
        g.fillText("🥕", cx, soil + unit * 3.5 - rise * unit * 6.5);
        g.restore();
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

    running: () => running,

    run(on, ctx) {
      if (running === on) return true;
      running = on;
      if (on) {
        /* 暫停過就從剩下的時間接著跑，不要重新給滿一分鐘 ——
           主持人按暫停多半是現場出了狀況（有人跌倒、麥克風壞掉），
           回來之後把時間重設等於前面白拔了。第一次開始時 left 是滿的。 */
        endsAt = performance.now() + left;
        meter.drain(ctx);
        announce(ctx, "拉！把蘿蔔拔起來！");
      } else {
        left = Math.max(0, endsAt - performance.now());
        announce(ctx, "暫停");
      }
      return true;
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (!running) {
          running = true;
          endsAt = performance.now() + CARROT_MS;
          left = CARROT_MS;
          meter.drain(ctx);
          announce(ctx, "拉！把蘿蔔拔起來！");
        } else {
          running = false;
          left = Math.max(0, endsAt - performance.now());
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
