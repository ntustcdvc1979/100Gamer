/* ============================================================
   遊戲：地理達人（個人賽）

   出一個地名（＋照片），玩家在手機上的台灣地圖點一個位置，
   30 秒後公布，離正確位置越近分數越高。

   分數用「差幾公里」算，不是畫面距離 —— 見 shared/taiwan.ts。
   10 公里內滿分（同一個市區內算猜對），100 公里歸零
   （台灣南北才 380 公里，差 100 公里等於猜到別的縣市去了）。

   投影幕上的地圖跟手機是同一份座標，所以「你點的點」畫在投影幕上
   的位置，跟玩家自己在手機上看到的是一樣的。

   跟拍照找顏色一樣，分數等時間到才公布：邊點邊看分數的話，
   大家會用二分搜尋逼近答案，就不是在考地理了。
   ============================================================ */

import { GEO_QUESTIONS } from "../../config/geo";
import { distanceKm, geoScore, outlinePath, project, unproject } from "../../shared/taiwan";
import { TEAMS } from "../../shared/teams";
import type { Game, GameContext } from "./types";

const ROUND_MS = 30_000;
const SHOW_TOP = 6;

interface Guess {
  x: number;
  y: number;
  km: number;
  score: number;
}

export function createGeoGame(): Game {
  /**
   * 題庫。config/geo.ts 是預設值，主控台可以整包換掉（geoList）
   * 或換掉某一題的照片（geoPhoto）。
   *
   * 照片存在這裡而不是 state：它只給投影幕看。一張壓過的圖還是有幾十 KB，
   * 乘以一百支手機就是幾 MB 的下行，而玩家低頭看手機時要看的是地圖，
   * 不是題目照片。
   */
  let items = GEO_QUESTIONS.map((q) => ({ ...q }));
  /** index → 已經載好的照片。主控台傳上來的是 data URI。 */
  const photos = new Map<number, HTMLImageElement>();
  let index = 0;
  /** 現在是不是正在這一關。主控台在別的關卡改題目時，不可以 publish 出去 —— 那會把當下的畫面蓋掉。 */
  let active = false;
  let running = false;
  let revealed = false;
  let endsAt = 0;
  const guesses = new Map<string, Guess>();
  let ranked: [string, Guess][] = [];

  function q() {
    return items[index] as (typeof items)[number];
  }

  function announce(ctx: GameContext, hint: string): void {
    ctx.publish({
      phase: "playing",
      game: "geo",
      round: index + 1,
      control: "tap",
      accepting: running,
      revealed,
      place: q().name + (q().hint ? `（${q().hint}）` : ""),
      hint,
      options: [],
    });
  }

  function load(ctx: GameContext): void {
    running = false;
    revealed = false;
    guesses.clear();
    ranked = [];
    ctx.field.reset(false);
    announce(ctx, `第 ${index + 1} 題：${q().name}　等主持人開始`);
  }

  function reveal(ctx: GameContext): void {
    running = false;
    revealed = true;
    ranked = [...guesses.entries()].sort((a, b) => a[1].km - b[1].km);
    for (const [uid, g] of ranked) {
      const actor = ctx.field.actors.get(uid);
      if (actor) actor.score = g.score;
    }
    const best = ranked[0];
    announce(
      ctx,
      best
        ? `答案是 ${q().name}。最近的是 ${ctx.field.actors.get(best[0])?.name ?? ""}，差 ${best[1].km.toFixed(1)} 公里`
        : "沒有人作答",
    );
  }

  /** 地圖在投影幕上的位置。留左邊給題目與排名。 */
  function mapBox(ctx: GameContext): { x: number; y: number; w: number; h: number } {
    const { w, h } = ctx.surface;
    const mh = h * 0.86;
    // 台灣大約 1:1.7，照這個比例抓寬度
    const mw = mh * 0.62;
    return { x: w - mw - h * 0.05, y: h * 0.07, w: mw, h: mh };
  }

  return {
    id: "geo",
    title: "地理達人",
    // 地圖畫在右半邊，右上角的 QR 會整個蓋住宜蘭花蓮那一段
    hideQr: true,
    brief: "個人賽。30秒內，玩家在手機的地圖上點你認為的位置。",

    enter(ctx) {
      active = true;
      index = 0;
      load(ctx);
    },

    exit() {
      active = false;
    },

    step(_dt, now, ctx) {
      if (running && now >= endsAt) reveal(ctx);

      // 收件中才送隊友的點。公布之後投影幕上什麼都看得到了，
      // 再送就是白燒頻寬。
      if (running) {
        const byTeam: Record<string, [number, number][]> = {};
        for (const [uid, gu] of guesses) {
          const a = ctx.field.actors.get(uid);
          if (!a) continue;
          // 小數點三位就夠了（約 200 公尺），多送的位數只是浪費
          (byTeam[a.team] ??= []).push([
            Math.round(gu.x * 1000) / 1000,
            Math.round(gu.y * 1000) / 1000,
          ]);
        }
        ctx.publishPins(byTeam);
      }
    },

    action(uid, a, ctx) {
      if (a.k !== "tap" || !running) return;
      if (!ctx.field.actors.has(uid)) return;

      // 可以一直改，時間到才算。之前擋成「一人一次」是怕有人用二分搜尋
      // 逼近答案 —— 但分數本來就等時間到才公布，過程中沒有任何回饋可以逼近，
      // 擋掉只是讓手滑點錯的人整題報銷。
      //
      // km 和分數還是每次都先算好：時間到的時候要馬上排得出名次，
      // 不能在那一幀才算一百次 haversine。
      const km = distanceKm(unproject(a.x, a.y), q());
      guesses.set(uid, { x: a.x, y: a.y, km, score: geoScore(km) });
    },

    draw(now, ctx) {
      const { ctx: g, unit } = ctx.surface;
      const box = mapBox(ctx);

      /* ---- 左側：題目、照片、排名 ---- */
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 7)}px system-ui, "Noto Sans TC", sans-serif`;
      // 從 unit*22 開始，讓開左上角 HUD（人數、關卡名、操作提示）
      g.fillText(q().name, unit * 4, unit * 22);
      if (q().hint) {
        g.font = `700 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillStyle = "rgba(255,255,255,.6)";
        g.fillText(q().hint as string, unit * 4, unit * 31);
      }

      // 照片（有放才畫）
      let infoY = unit * 37;
      const photo = photos.get(index);
      if (photo?.complete && photo.naturalWidth > 1) {
        const pw = Math.min(box.x - unit * 8, unit * 44);
        const ph = (photo.naturalHeight / photo.naturalWidth) * pw;
        g.drawImage(photo, unit * 4, infoY, pw, ph);
        infoY += ph + unit * 3;
      }

      g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillStyle = "#F2A72C";
      const left = running ? Math.ceil((endsAt - now) / 1000) : 0;
      g.fillText(
        revealed ? "公布答案" : running ? `${left} 秒　${guesses.size}人已作答` : "按 T 開始",
        unit * 4,
        infoY,
      );

      if (revealed && ranked.length > 0) {
        g.font = `700 ${Math.round(unit * 2.6)}px system-ui, "Noto Sans TC", sans-serif`;
        ranked.slice(0, SHOW_TOP).forEach(([uid, gu], i) => {
          const a = ctx.field.actors.get(uid);
          g.fillStyle = i === 0 ? "#F2A72C" : "rgba(255,255,255,.85)";
          g.fillText(
            `${i + 1}. ${a?.name ?? ""}　${gu.km.toFixed(1)} km　${gu.score} 分`,
            unit * 4,
            infoY + unit * (6 + i * 3.4),
          );
        });
      }

      /* ---- 右側：地圖 ---- */
      g.save();
      g.translate(box.x, box.y);

      g.fillStyle = "rgba(255,255,255,.07)";
      g.fillRect(0, 0, box.w, box.h);

      const path = new Path2D(outlinePath(box.w, box.h));
      g.fillStyle = "#2B3A2E";
      g.fill(path);
      g.strokeStyle = "rgba(255,255,255,.45)";
      g.lineWidth = Math.max(1.5, unit * 0.22);
      g.stroke(path);

      // 大家點的位置。**只在公布之後畫** ——
      // 收件中就畫出來的話，後面的人只要看投影幕上哪裡最密就好了，
      // 這一關會變成比誰晚點。
      if (revealed) {
        for (const [uid, gu] of guesses) {
          const a = ctx.field.actors.get(uid);
          g.globalAlpha = 0.9;
          g.fillStyle = a ? TEAMS[a.team].color : "#888";
          g.beginPath();
          g.arc(gu.x * box.w, gu.y * box.h, unit * 1.1, 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
      }

      if (revealed) {
        const t = project(q());
        const tx = t.x * box.w;
        const ty = t.y * box.h;

        // 從前幾名連一條線到正確位置，看得出誰近誰遠
        g.strokeStyle = "rgba(242,167,44,.55)";
        g.lineWidth = Math.max(1, unit * 0.18);
        for (const [, gu] of ranked.slice(0, SHOW_TOP)) {
          g.beginPath();
          g.moveTo(gu.x * box.w, gu.y * box.h);
          g.lineTo(tx, ty);
          g.stroke();
        }

        // 正確位置
        g.fillStyle = "#F2A72C";
        g.beginPath();
        g.arc(tx, ty, unit * 2.2, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = "#FFFFFF";
        g.lineWidth = Math.max(2, unit * 0.35);
        g.stroke();

        g.fillStyle = "#FFFFFF";
        g.textAlign = "center";
        g.textBaseline = "bottom";
        g.font = `900 ${Math.round(unit * 3)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillText(q().name, tx, ty - unit * 3.4);
      }

      g.restore();
    },

    /**
     * 主控台改題庫。整包換掉，然後回到第一題 ——
     * 編輯到一半還停在舊題目的話，畫面和資料會對不起來。
     */
    setGeoList(list, ctx) {
      items = list.map((it) => ({ ...it }));
      if (items.length === 0) items = GEO_QUESTIONS.map((q) => ({ ...q }));
      photos.clear();
      index = 0;
      running = false;
      revealed = false;
      guesses.clear();
      ranked = [];
      // 只有人在這一關的時候才 publish。在別的關卡改題目時 publish
      // 會把那一關的 state 蓋掉，一百支手機會瞬間跳到地理達人的畫面。
      if (active) load(ctx);
    },

    /** 主控台換某一題的照片。data URI 直接塞進 Image。 */
    setGeoPhoto(i, dataUri) {
      if (i < 0 || i >= items.length) return;
      if (!dataUri) {
        photos.delete(i);
        return;
      }
      const img = new Image();
      img.src = dataUri;
      photos.set(i, img);
    },

    key(e, ctx) {
      if (e.key === "t" || e.key === "T") {
        if (revealed) return true;
        if (running) {
          reveal(ctx);
          return true;
        }
        running = true;
        endsAt = performance.now() + ROUND_MS;
        announce(ctx, `${q().name} 在哪裡？在地圖上點一下`);
        return true;
      }
      if (e.key === "ArrowRight" && index < items.length - 1) {
        index++;
        load(ctx);
        return true;
      }
      if (e.key === "r" || e.key === "R") {
        load(ctx);
        return true;
      }
      return false;
    },

  };
}
