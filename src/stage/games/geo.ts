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
import { COUNTY_LABELS, countyPaths, distanceKm, geoScore, outlinePath, project, unproject } from "../../shared/taiwan";
import { TEAMS, TEAM_IDS } from "../../shared/teams";
import { GEO_ROUND_MS as ROUND_MS } from "../../shared/rules";
import type { Game, GameContext } from "./types";

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
      /* 公布之後才把答案的座標送出去。
         沒公布前送等於直接把答案給玩家（打開 devtools 就看得到）；
         公布之後手機才畫得出正確位置、也才算得出「我差幾公里」——
         而那個數字必須是他自己的，不是全場最近的那個人的。
         兩個數字而已，一題只送一次，對下行沒有影響。 */
      answer: revealed ? [q().lon, q().lat] : undefined,
      /* 各隊到目前為止的總分。這一關的分數是個人的，但主持人和玩家
         都會想知道自己這一隊領先沒有。 */
      teams: teamScores(ctx),
      hint,
      options: [],
    });
  }

  /** 各隊在這一關的累計分數。 */
  function teamScores(ctx: GameContext): Record<string, { score: number }> {
    const out: Record<string, { score: number }> = {};
    for (const id of TEAM_IDS) out[id] = { score: 0 };
    for (const a of ctx.field.actors.values()) {
      const t = out[a.team];
      if (t) t.score += a.score;
    }
    return out;
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

  /** 地圖在投影幕上的位置。置中，左邊放題目與照片、右邊放名次。 */
  function mapBox(ctx: GameContext): { x: number; y: number; w: number; h: number } {
    const { w, h } = ctx.surface;
    const mh = h * 0.84;
    // 台灣大約 1:1.7，照這個比例抓寬度
    const mw = mh * 0.62;
    // 置中。左邊放題目與照片，右邊放名次（右上角要讓開 QR）。
    return { x: (w - mw) / 2, y: h * 0.08, w: mw, h: mh };
  }

  return {
    id: "geo",
    title: "地理達人",
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

      /* ---- 左欄：題目、照片、倒數 ----
         左欄的寬度就是「畫面左緣到地圖左緣」那一段。照片與文字都夾在
         這個寬度裡，所以永遠不會壓到地圖；高度也另外夾住，不會掉出畫面。 */
      const pad = unit * 3;
      const colW = box.x - pad * 2;

      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 6)}px system-ui, "Noto Sans TC", sans-serif`;
      // 從 unit*18 開始，讓開左上角 HUD（人數、關卡名）
      g.fillText(q().name, pad, unit * 18);
      if (q().hint) {
        g.font = `700 ${Math.round(unit * 2.6)}px system-ui, "Noto Sans TC", sans-serif`;
        g.fillStyle = "rgba(255,255,255,.6)";
        g.fillText(q().hint as string, pad, unit * 26);
      }

      // 照片。盡量放大到左欄的寬度，但高度不能讓它掉出畫面下緣。
      let infoY = unit * 32;
      const photo = photos.get(index);
      if (photo?.complete && photo.naturalWidth > 1) {
        const maxH = ctx.surface.h - infoY - unit * 14; // 下面還要留倒數的位置
        const scale = Math.min(colW / photo.naturalWidth, maxH / photo.naturalHeight);
        const pw = photo.naturalWidth * scale;
        const ph = photo.naturalHeight * scale;
        // 在左欄裡置中，直式橫式都不會偏到一邊
        g.drawImage(photo, pad + (colW - pw) / 2, infoY, pw, ph);
        infoY += ph + unit * 3;
      }

      g.font = `900 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillStyle = "#F2A72C";
      const left = running ? Math.ceil((endsAt - now) / 1000) : 0;
      g.fillText(
        revealed ? "公布答案" : running ? `${left} 秒　${guesses.size}人已作答` : "準備中",
        pad,
        infoY,
      );

      /* ---- 左欄下方：各隊目前分數 ----
         這一關是個人賽，但大家關心的還是自己那一隊有沒有領先。
         放左下角，跟題目同一欄，不會壓到地圖也不會被 QR 蓋到。 */
      {
        const scores = teamScores(ctx);
        const baseY = ctx.surface.h - unit * 11;
        g.textAlign = "left";
        g.textBaseline = "middle";
        g.font = `900 ${Math.round(unit * 2.6)}px system-ui, "Noto Sans TC", sans-serif`;
        TEAM_IDS.forEach((id, i) => {
          const y = baseY + Math.floor(i / 2) * unit * 4;
          const x = pad + (i % 2) * (colW / 2);
          g.fillStyle = TEAMS[id].color;
          g.fillText(TEAMS[id].name, x, y);
          g.fillStyle = "#FFFFFF";
          g.fillText(`${scores[id]?.score ?? 0}`, x + unit * 9, y);
        });
      }

      /* ---- 右欄：名次。從 QR 下面開始，不要被蓋到。 ---- */
      if (revealed && ranked.length > 0) {
        const rx = box.x + box.w + pad;
        g.font = `700 ${Math.round(unit * 2.6)}px system-ui, "Noto Sans TC", sans-serif`;
        ranked.slice(0, SHOW_TOP).forEach(([uid, gu], i) => {
          const a = ctx.field.actors.get(uid);
          g.fillStyle = i === 0 ? "#F2A72C" : "rgba(255,255,255,.85)";
          g.fillText(
            `${i + 1}. ${a?.name ?? ""}　${gu.km.toFixed(1)} km　${gu.score} 分`,
            rx,
            unit * 32 + i * unit * 4,
          );
        });
      }

      /* ---- 中間：地圖 ---- */
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

      /* 縣市界。畫在島的裡面（用海岸線裁切），不然分界線會戳到海裡。
         它是示意不是行政區圖 —— 目的是讓人一眼抓到「大概在哪一區」。 */
      g.save();
      g.clip(path);
      g.strokeStyle = "rgba(255,255,255,.22)";
      g.lineWidth = Math.max(1, unit * 0.14);
      for (const d of countyPaths(box.w, box.h)) g.stroke(new Path2D(d));
      g.restore();

      g.save();
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "rgba(255,255,255,.35)";
      g.font = `700 ${Math.round(unit * 1.9)}px system-ui, "Noto Sans TC", sans-serif`;
      for (const c of COUNTY_LABELS) {
        const p = project(c);
        g.fillText(c.name, p.x * box.w, p.y * box.h);
      }
      g.restore();

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
      // 內容一模一樣就什麼都不做。
      //
      // 主控台重連時會自動把自己存的題庫推上來（伺服器重啟的自我修復），
      // 不擋掉的話，主持人一重整主控台就會把進行中的那一題打回第一題。
      const same =
        list.length === items.length &&
        list.every((it, i) => {
          const cur = items[i];
          return (
            cur !== undefined &&
            it.name === cur.name &&
            (it.hint ?? "") === (cur.hint ?? "") &&
            it.lon === cur.lon &&
            it.lat === cur.lat
          );
        });
      if (same) return;

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

    running: () => running,

    /* 這一關沒有暫停：計時一開始，一百支手機就在點地圖了，
       中途凍住只會讓人以為自己斷線。on=false 回 false，
       主控台會告訴主持人「這一關不能暫停，要提早結束請按公布」。 */
    run(on, ctx) {
      if (!on) return false;
      if (running || revealed) return true;
      running = true;
      endsAt = performance.now() + ROUND_MS;
      announce(ctx, `${q().name} 在哪裡？在地圖上點一下`);
      return true;
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
