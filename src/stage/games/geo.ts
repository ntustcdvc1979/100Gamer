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
import { DISPLAY_ORDER, TEAMS, TEAM_IDS } from "../../shared/teams";
import { bigText, card, flushPikmin, font, pikmin, roundRect, scenery, shade, timerBadge } from "../cartoon";
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
  /** 公布的時刻，旗子彈一下的動畫用 */
  let revealedAt = 0;
  /** 上一次響倒數滴答的秒數，一秒只響一次 */
  let lastTick = 0;
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
      /* 題目等主持人按開始才送。待機時就送出去的話，手快的人會先在
         手機上查好位置，開始一按就點 —— 那就不是在比地理了。 */
      place: running || revealed ? q().name + (q().hint ? `（${q().hint}）` : "") : `第 ${index + 1} 題`,
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
    announce(ctx, `第 ${index + 1} 題　等主持人開始`);
  }

  function reveal(ctx: GameContext): void {
    running = false;
    revealed = true;
    revealedAt = performance.now();
    // 鼓聲滾奏＋「登登！」—— 全場抬頭看投影幕的那一刻
    ctx.sfx("reveal");
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
    cartoon: true,
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

      // 最後五秒每秒滴答一聲
      if (running) {
        const left = Math.ceil((endsAt - now) / 1000);
        if (left <= 5 && left > 0 && left !== lastTick) {
          lastTick = left;
          ctx.sfx("tick");
        }
      }

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
      const { ctx: g, w, h, unit } = ctx.surface;
      const box = mapBox(ctx);
      scenery(g, w, h, now, "meadow", 0.86);

      /* ---- 左欄：題目、照片、倒數 ----
         左欄的寬度就是「畫面左緣到地圖左緣」那一段。照片與文字都夾在
         這個寬度裡，所以永遠不會壓到地圖；高度也另外夾住，不會掉出畫面。 */
      const pad = unit * 3;
      const colW = box.x - pad * 2;
      const colX = pad;

      // 題目卡。從 HUD（關卡名）底下開始，不要被它蓋住。
      const qTop = Math.max(unit * 12, ctx.hudBottom() + unit * 2);
      card(g, colX, qTop, colW, unit * 16, "#FFFFFF", unit, "#1E4FB8");
      // 待機時只寫第幾題：題目和照片都等開始才亮出來
      const shown = running || revealed;
      bigText(g, shown ? q().name : `第 ${index + 1} 題`, colX + colW / 2, qTop + unit * 6.5, unit * 5.5, "#1E4FB8");
      if (!shown) {
        g.font = font(unit * 2.3, 400);
        g.fillStyle = "#4A5570";
        g.textAlign = "center";
        g.fillText("主持人按開始就公布題目", colX + colW / 2, qTop + unit * 12.3);
      } else if (q().hint) {
        g.font = font(unit * 2.3, 400);
        g.fillStyle = "#4A5570";
        g.textAlign = "center";
        g.fillText(q().hint as string, colX + colW / 2, qTop + unit * 12.3);
      }

      // 照片做成拍立得：白框、微微歪一點
      let infoY = qTop + unit * 19;
      const photo = shown ? photos.get(index) : undefined;
      if (photo?.complete && photo.naturalWidth > 1) {
        const maxH = h - infoY - unit * 38; // 下面還要留倒數與隊伍分數
        if (maxH > unit * 5) {
          const scale = Math.min((colW - unit * 4) / photo.naturalWidth, maxH / photo.naturalHeight);
          const pw = photo.naturalWidth * scale;
          const ph = photo.naturalHeight * scale;
          g.save();
          g.translate(colX + colW / 2, infoY + ph / 2 + unit);
          g.rotate(-0.035);
          g.shadowColor = "rgba(0,0,0,.25)";
          g.shadowBlur = unit * 1.5;
          g.fillStyle = "#FFFFFF";
          g.fillRect(-pw / 2 - unit, -ph / 2 - unit, pw + unit * 2, ph + unit * 4);
          g.shadowBlur = 0;
          g.drawImage(photo, -pw / 2, -ph / 2, pw, ph);
          g.restore();
          infoY += ph + unit * 6;
        }
      }

      // 倒數圓章＋狀態
      const left = running ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 0;
      const badgeR = unit * 5;
      timerBadge(
        g, colX + badgeR + unit, infoY + badgeR,
        badgeR,
        revealed ? "公布" : running ? String(left) : "準備",
        now,
        running && left <= 5,
      );
      g.font = font(unit * 2.6);
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillStyle = "#1E3A7A";
      g.fillText(
        revealed ? "答案揭曉！" : running ? `${guesses.size} 人已作答` : "等主持人開始",
        colX + badgeR * 2 + unit * 3,
        infoY + badgeR,
      );

      /* ---- 左欄下方：各隊目前分數 ----
         這一關是個人賽，但大家關心的還是自己那一隊有沒有領先。
         每隊一顆膠囊，前面站一隻小皮克敏。 */
      {
        const scores = teamScores(ctx);
        const rowH = unit * 5.2;
        const pillH = rowH - unit * 0.8;
        const baseY = h - unit * 4 - rowH * 4;
        DISPLAY_ORDER.forEach((id, i) => {
          const t = TEAMS[id];
          const y = baseY + i * rowH;
          roundRect(g, colX, y, colW, pillH, pillH / 2);
          g.fillStyle = "rgba(255,255,255,.92)";
          g.fill();
          g.strokeStyle = t.light ? "#B8C0CE" : t.color;
          g.lineWidth = unit * 0.4;
          g.stroke();
          pikmin(g, colX + unit * 3.2, y + pillH - unit * 0.3, rowH * 1.05, id, { t: now, phase: i });
          g.font = font(unit * 2.4);
          g.textAlign = "left";
          g.textBaseline = "middle";
          g.fillStyle = t.light ? "#3A4A66" : shade(t.color, -0.3);
          g.fillText(t.pikmin, colX + unit * 6.5, y + pillH / 2);
          g.textAlign = "right";
          g.fillStyle = "#1E3A7A";
          g.fillText(String(scores[id]?.score ?? 0), colX + colW - unit * 2, y + pillH / 2);
        });
      }

      flushPikmin(g);

      /* ---- 中間：地圖，畫成一張藏寶圖卡片 ---- */
      const mapPad = unit * 1.5;
      card(g, box.x - mapPad, box.y - mapPad, box.w + mapPad * 2, box.h + mapPad * 2, "#BFE6FF", unit);

      g.save();
      g.translate(box.x, box.y);

      // 海浪紋
      g.strokeStyle = "rgba(255,255,255,.6)";
      g.lineWidth = Math.max(1, unit * 0.2);
      for (let i = 0; i < 9; i++) {
        const wy = box.h * (0.08 + i * 0.11);
        const wx = (((i * 37) % 70) / 100) * box.w;
        g.beginPath();
        g.arc(wx, wy, unit * 1.2, Math.PI * 1.1, Math.PI * 1.9);
        g.stroke();
        g.beginPath();
        g.arc(wx + unit * 2.2, wy, unit * 1.2, Math.PI * 1.1, Math.PI * 1.9);
        g.stroke();
      }

      const path = new Path2D(outlinePath(box.w, box.h));
      const land = g.createLinearGradient(0, 0, 0, box.h);
      land.addColorStop(0, "#8FD16A");
      land.addColorStop(1, "#5DB043");
      g.fillStyle = land;
      g.fill(path);
      g.strokeStyle = "#FFFFFF";
      g.lineWidth = Math.max(2, unit * 0.45);
      g.stroke(path);

      /* 縣市界（內政部的真實界線）。畫在島的裡面（用海岸線裁切），
         簡化過的界線端點跟海岸差一點點，不裁的話會有幾根線頭戳到海裡。 */
      g.save();
      g.clip(path);
      g.strokeStyle = "rgba(255,255,255,.75)";
      g.lineWidth = Math.max(1, unit * 0.22);
      g.lineJoin = "round";
      for (const d of countyPaths(box.w, box.h)) g.stroke(new Path2D(d));
      g.restore();

      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = font(unit * 1.8);
      g.fillStyle = "rgba(30,70,20,.7)";
      for (const c of COUNTY_LABELS) {
        const p = project(c);
        g.fillText(c.name, p.x * box.w, p.y * box.h);
      }

      // 大家點的位置。**只在公布之後畫** ——
      // 收件中就畫出來的話，後面的人只要看投影幕上哪裡最密就好了，
      // 這一關會變成比誰晚點。
      if (revealed) {
        for (const [uid, gu] of guesses) {
          const a = ctx.field.actors.get(uid);
          g.fillStyle = a ? TEAMS[a.team].color : "#888";
          g.strokeStyle = a && TEAMS[a.team].light ? "#5A6478" : "#FFFFFF";
          g.lineWidth = Math.max(1, unit * 0.25);
          g.beginPath();
          g.arc(gu.x * box.w, gu.y * box.h, unit * 1.1, 0, Math.PI * 2);
          g.fill();
          g.stroke();
        }

        const t = project(q());
        const tx = t.x * box.w;
        const ty = t.y * box.h;

        // 從前幾名連一條虛線到正確位置，看得出誰近誰遠
        g.strokeStyle = "rgba(230,90,30,.75)";
        g.lineWidth = Math.max(1, unit * 0.22);
        g.setLineDash([unit * 0.7, unit * 0.5]);
        for (const [, gu] of ranked.slice(0, SHOW_TOP)) {
          g.beginPath();
          g.moveTo(gu.x * box.w, gu.y * box.h);
          g.lineTo(tx, ty);
          g.stroke();
        }
        g.setLineDash([]);

        // 正確位置插一支旗子，公布的瞬間彈一下
        const k = Math.min(1, (now - revealedAt) / 450);
        const bounce = 1 + Math.sin(k * Math.PI) * 0.35;
        const fh = unit * 7 * bounce;
        g.strokeStyle = "#5A3517";
        g.lineWidth = unit * 0.5;
        g.beginPath();
        g.moveTo(tx, ty);
        g.lineTo(tx, ty - fh);
        g.stroke();
        const flutter = Math.sin(now / 180) * unit * 0.6;
        g.fillStyle = "#FF3B30";
        g.beginPath();
        g.moveTo(tx, ty - fh);
        g.quadraticCurveTo(tx + unit * 2.5, ty - fh + unit * 0.6 + flutter, tx + unit * 4.5, ty - fh + unit * 1.6);
        g.lineTo(tx, ty - fh + unit * 3.2);
        g.closePath();
        g.fill();
        g.fillStyle = "#5A3517";
        g.beginPath();
        g.ellipse(tx, ty, unit * 1.2, unit * 0.45, 0, 0, Math.PI * 2);
        g.fill();

        bigText(g, q().name, tx, ty - fh - unit * 2.5, unit * 3, "#E23B2E");
      }

      g.restore();

      /* ---- 右欄：名次。從 QR 下面開始，不要被蓋到。 ---- */
      if (revealed && ranked.length > 0) {
        const rx = box.x + box.w + pad;
        const rw = w - rx - pad;
        const rTop = h * 0.36;
        const rowH = unit * 5;
        const shown = ranked.slice(0, SHOW_TOP);
        card(g, rx, rTop, rw, unit * 8 + shown.length * rowH, "#FFFFFF", unit, "#F2A72C");
        bigText(g, "最接近的人", rx + rw / 2, rTop + unit * 3.8, unit * 3, "#E07B00");
        shown.forEach(([uid, gu], i) => {
          const a = ctx.field.actors.get(uid);
          const y = rTop + unit * 9.5 + i * rowH;
          g.font = font(unit * 2.4);
          g.textBaseline = "middle";
          g.textAlign = "left";
          // 名次用圓牌，不用 emoji —— 投影幕那台的系統字型不一定有彩色 emoji
          const medal = ["#F2B705", "#B7BFCC", "#C98446"][i] ?? "#E3E7EE";
          g.fillStyle = medal;
          g.beginPath();
          g.arc(rx + unit * 3, y, unit * 1.7, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = i < 3 ? "#FFFFFF" : "#4A5570";
          g.textAlign = "center";
          g.fillText(String(i + 1), rx + unit * 3, y + unit * 0.1);
          g.textAlign = "left";
          g.fillStyle = a ? (TEAMS[a.team].light ? "#3A4A66" : shade(TEAMS[a.team].color, -0.25)) : "#333";
          g.fillText(a?.name ?? "", rx + unit * 6, y);
          g.textAlign = "right";
          g.fillStyle = "#1E3A7A";
          g.fillText(`${gu.km.toFixed(1)} km`, rx + rw - unit * 1.5, y);
        });
      }
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
      lastTick = 0;
      ctx.sfx("start");
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
