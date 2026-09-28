/* ============================================================
   投影幕

   它是唯一做全域訂閱的客戶端：state、players、inputs、actions 都聽，
   而且是唯一算分數的地方。主控台只是遙控器，真相在這裡。

   鍵盤（跟主控台上的按鈕是同一套，主控台送 {k:"key"} 過來就是模擬按鍵）：
     →        下一關（遊戲可以先吃掉，例如換題目）
     ←        上一關
     T        開始／暫停　　R  重來
     L        總排行榜      F  全螢幕      Esc  關卡選單
   ============================================================ */

import "../shared/base.css";
import "./stage.css";
import { svg } from "../shared/qrcode.js";
import { openRoom, playUrl } from "../net/room";
import { normalizeLanBase, PUBLIC_SITE, siteBase } from "../net/wsurl";
import { createStageAudio } from "./audio";
import { drawPreview } from "./preview";
import { flushPikmin } from "./cartoon";
import { clearPropCache } from "./three/props";
import { createSurface } from "./canvas";
import { Field } from "./render";
import { createGames, type Game, type GameContext } from "./games";
import { TEAMS, TEAM_IDS } from "../shared/teams";
import type { Player, ScoreRow } from "../net/schema";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const statusEl = $("status");
const statusText = $("statusText");
const countEl = $("count");

function setStatus(ok: boolean, text: string): void {
  statusEl.classList.toggle("on", ok);
  statusText.textContent = text;
}

async function main(): Promise<void> {
  const room = await openRoom("stage");

  if (room.kind === "local") {
    // 本機模式一定要看得出來。這一格被蓋成「已連線」的話，主持人會以為
    // 手機都同步好了才開場 —— 那是現場最貴的誤會。
    setStatus(false, "本機模式");
  } else {
    setStatus(false, "連線中…");
    // 備用機不能顯示「已連線」—— 那會讓人以為該看這一台。
    room.onConnection((ok) =>
      setStatus(ok, !ok ? "連線中斷" : room.isHost ? "已連線" : "備用中"),
    );
  }
  if (!room.isHost) {
    setStatus(false, "備用中（已有另一台投影幕）");
    // 主機掛掉時這一台會自動接手，接手了要講 ——
    // 不然現場沒有人知道該看哪一台。
    room.onBecameHost(() => setStatus(true, "已接手，這台是主投影幕"));
  }

  const url = playUrl();
  $("url").textContent = url;
  try {
    $("qr").innerHTML = svg(url);
  } catch {
    $("qr").textContent = "QR 產生失敗";
  }

  const surface = createSurface($<HTMLCanvasElement>("stage"));
  const field = new Field();
  const games = createGames();
  const audio = createStageAudio();
  const ctx: GameContext = {
    field,
    surface,
    publish: (patch) => room.publishState(patch),
    publishPins: (pins) => room.publishPins(pins),
    sfx: (name) => audio.sfx(name),
    qrLeft: () => {
      const panel = $("qrPanel");
      if (panel.hidden) return surface.w;
      const scale = surface.w / window.innerWidth; // CSS 像素 → 畫布像素（dpr）
      return panel.getBoundingClientRect().left * scale;
    },
    hudBottom: () => {
      const hud = document.querySelector<HTMLElement>(".hud");
      // 不能用 offsetParent 判斷有沒有顯示 —— position:fixed 的元素 offsetParent 永遠是 null
      if (!hud || getComputedStyle(hud).display === "none") return 0;
      return hud.getBoundingClientRect().bottom * (surface.w / window.innerWidth);
    },
  };

  /* 聲音要等使用者碰過頁面才放得出來（瀏覽器的規定）。
     投影幕那台開場時本來就會按 F 全螢幕或點一下畫面，那一下就順便解鎖。
     還沒解鎖之前左下角掛一個提示 —— 主持人不會知道為什麼沒有聲音。 */
  const soundHint = $("soundHint");
  const unlock = (): void => {
    audio.unlock();
    setTimeout(() => (soundHint.hidden = audio.unlocked), 200);
  };
  window.addEventListener("keydown", unlock);
  window.addEventListener("pointerdown", unlock);
  setInterval(() => (soundHint.hidden = audio.unlocked), 1000);

  let index = -1;
  let game: Game | null = null;
  let showLeaderboard = false;
  /** 主持人有沒有把 QR 打開。關卡自己也可以要求收起來（hideQr）。 */
  let qrWanted = true;

  let playerCount = 0;
  function syncQr(): void {
    $("qrPanel").hidden = game?.hideQr === true || !qrWanted;
    // 有人進來之後 QR 縮小讓出畫面 —— 但大廳例外：那時候大家正在掃
    $("qrPanel").classList.toggle("small", playerCount > 0 && game?.id !== "lobby");
  }

  /**
   * 排行榜是畫在 canvas 上的，但 HUD 與 QR 是 DOM，會浮在 canvas 上面。
   * 不把它們收起來的話，頒獎畫面會被「100 人已加入」和一張 QR 蓋著。
   */
  function setLeaderboard(on: boolean): void {
    showLeaderboard = on;
    document.body.classList.toggle("board", on);
  }

  function go(next: number): void {
    const clamped = Math.max(0, Math.min(games.length - 1, next));
    if (clamped === index) return;
    // 離開一關就把分數存進總分，不然換關卡分數就沒了
    if (game) field.bankScores();
    game?.exit?.(ctx);
    index = clamped;
    game = games[index] as Game;
    // 先清掉上一關的 state 再讓新的關卡填 —— 不清的話舊欄位會沿用下去
    room.clearGameState();
    // 上一關拍好的 3D 圖用不到了，放掉記憶體
    clearPropCache();
    game.enter(ctx);
    $("gameTitle").textContent = game.title;
    // 卡通主題的關卡底是亮的天空，HUD 要換一套配色（見 stage.css）
    document.body.classList.toggle("cartoon", game.cartoon === true);
    // 大廳和頒獎自己畫了大標題，左上角那顆關卡名是多餘的，還會壓到名次
    document.body.classList.toggle("noHud", game.id === "lobby" || game.id === "finale");
    audio.setBgm(game.bgm ?? "play");
    // brief 是給主持人看的操作說明（按什麼鍵、怎麼換題），
    // 觀眾不需要，所以只留在 Esc 的關卡選單裡，不印在投影幕上。
    syncQr();
    renderMenu();
  }

  function renderMenu(): void {
    $("menu").innerHTML = games
      .map(
        (g, i) =>
          `<li class="${i === index ? "on" : ""}"><b>${i + 1}</b> ${g.title}<span>${g.brief}</span></li>`,
      )
      .join("");
  }

  /** 排行榜的資料來源。總分 + 這一關的分數，主控台和投影幕看的是同一份。 */
  function scoreRows(): ScoreRow[] {
    return [...field.actors.entries()]
      .map(([uid, a]) => ({
        uid,
        name: a.name,
        team: a.team,
        total: a.total + a.score,
        round: a.score,
      }))
      .sort((x, y) => y.total - x.total);
  }

  room.onPlayers((players: Record<string, Player>) => {
    const uids = new Set(Object.keys(players));
    field.retain(uids);
    for (const [uid, p] of Object.entries(players)) {
      if (!p?.name || !p.team) continue;
      field.upsert(uid, p.name, p.team);
    }
    countEl.textContent = String(uids.size);
    playerCount = uids.size;
    syncQr();

    // 各隊人數不再廣播給手機（手機上也不顯示）。主控台自己從計分表算。
  });

  // 輸入：高頻，這是整個系統的熱路徑。這裡只把向量抄進記憶體，
  // 實際的移動交給每幀積分 —— 收到 20 Hz 的輸入也能畫出 60 fps 的動作。
  room.onInputs((inputs) => {
    const now = performance.now();
    for (const [uid, input] of Object.entries(inputs)) {
      if (!input?.v) continue;
      field.applyInput(uid, input.v[0] ?? 0, input.v[1] ?? 0, now, input.s);
    }
  });

  // 接手：伺服器在連線時會把最後一張計分表送過來，把總分接回去。
  // 只做一次 —— 之後的分數都是這台自己算的，不能被舊資料蓋掉。
  let restored = false;
  room.onScores((rows) => {
    if (restored) return;
    restored = true;
    for (const r of rows) {
      const a = field.actors.get(r.uid);
      if (a) a.total = r.total;
    }
    if (rows.length) console.info(`[p100] 接手了 ${rows.length} 筆分數`);
  });

  // 一次性事件（拍到的顏色、翻面的時間）交給當前的遊戲處理
  room.onActions((uid, action) => game?.action?.(uid, action, ctx));

  /**
   * 把「這一局在跑沒有」回報給主控台。
   *
   * 統一在這裡送，不要交給各個關卡自己 publish：「時間到自動停」那條路
   * 很容易漏掉，主控台的按鈕就會停在錯的狀態 —— 而主持人正是看著那個
   * 按鈕決定要不要再按一次的。
   *
   * 按下指令時立刻叫一次（要快），另外掛在 500ms 的心跳上（要漏不掉）。
   * 心跳刻意用 setInterval 而不是 rAF：投影幕視窗被縮小或切到背景時
   * rAF 會整個停掉，計分表當年就是為了這件事才搬出 rAF 的。
   * publishState 會過濾掉沒變的欄位，所以多叫幾次不會產生流量。
   */
  let lastRunning = false;
  function reportRunning(): void {
    const isRunning = game?.running?.() ?? false;
    if (isRunning === lastRunning) return;
    lastRunning = isRunning;
    room.publishState({ running: isRunning });
  }

  // 主控台的遙控。這裡不檢查權限 —— 伺服器只把驗過的主控台的指令轉過來。
  room.onCommand((cmd) => {
    switch (cmd.k) {
      case "goto":
        go(cmd.index);
        break;
      case "key":
        applyKey(new KeyboardEvent("keydown", { key: cmd.key }));
        break;
      case "run":
        /* 沒實作 run 的關卡（聚沙成塔）就當作沒有開始這回事。
           回傳 false 代表這一關不支援（多半是「不能暫停」），
           主控台會據此告訴主持人，而不是讓按鈕看起來沒反應。 */
        game?.run?.(cmd.on, ctx);
        // 立刻回報，不要等下一個 500ms 的心跳。
        // 主持人剛按完那一下正是最需要看到回應的時候 —— 慢半秒，
        // 他就會懷疑指令掉了然後再按一次。
        reportRunning();
        break;
      case "leaderboard":
        setLeaderboard(cmd.on);
        break;
      case "qr":
        qrWanted = cmd.on;
        syncQr();
        break;
      case "sound":
        audio.setEnabled(cmd.bgm, cmd.sfx);
        break;
      case "netMode": {
        /* 切換連線模式 = 整個投影幕換到另一個網站去開（見 net/wsurl.ts）。
           先告訴手機要去哪裡（它們會跳出「換 Wi-Fi、點一下前往」的提示），
           等一下下讓這個 state 送出去，再自己跳過去。
           新的那邊是另一台伺服器，分數不會跟過去 —— 主控台切之前會先警告。 */
        const target = cmd.mode === "B" ? normalizeLanBase(cmd.lan ?? "") : PUBLIC_SITE;
        if (!target || target === siteBase()) break;
        room.publishState({ netSwitch: { mode: cmd.mode, playUrl: `${target}play.html`, wifi: cmd.wifi } });
        setStatus(false, cmd.mode === "B" ? "切換到區網模式中…" : "切換到各自網路模式中…");
        setTimeout(() => location.assign(`${target}stage.html`), 2500);
        break;
      }
      case "resetScores":
        field.clearTotals();
        break;
      // 設定與題庫要送給**所有**關卡，不是只有目前這一關。
      // 主持人本來就是在別的關卡時先把題目和參數準備好的，
      // 只送給當前關卡的話，人在頒獎畫面改地理題目會完全沒有反應。
      case "setting":
        for (const g of games) g.setting?.(cmd.key, cmd.value);
        break;
      case "geoList":
        for (const g of games) g.setGeoList?.(cmd.list, ctx);
        break;
      case "geoPhoto":
        for (const g of games) g.setGeoPhoto?.(cmd.index, cmd.dataUri);
        break;
    }
  });

  go(0);

  /** rAF 停住的時候畫面上已經在警告了，恢復時要把字改回來。 */
  let stalled = false;
  let last = performance.now();

  // 計分表用 setInterval 而不是塞在 rAF 迴圈裡：分頁一被切到背景 rAF 就停，
  // 主控台會整個瞎掉。setInterval 在背景分頁還是會跑（會被降到 1 Hz，
  // 對一張 2 Hz 的計分表完全夠）。
  const scoreTimer = setInterval(() => {
    room.publishScores(scoreRows());
    reportRunning();

    /* 畫面停了就要講出來。
       rAF 只在分頁真的在繪製時才跑，所以投影幕被縮到最小、被別的視窗
       完全蓋住、或是螢幕保護程式跳出來的時候，整個遊戲迴圈會停 ——
       計分、倒數、判定全部凍住，但畫面上最後一幀還留著，看起來很正常。
       現場的症狀是「大家都在搖，分數卻不動」，而沒有人會想到是這個。
       setInterval 在背景分頁還是會跑，所以由它來抓。 */
    const frozen = performance.now() - last > 2000;
    if (frozen && game?.running?.()) {
      stalled = true;
      setStatus(false, "⚠️ 畫面停住了，請把投影幕視窗切回前景");
    } else if (stalled && !frozen) {
      stalled = false;
      setStatus(room.connected, room.connected ? "已連線" : "連線中斷");
    }
  }, 500);
  window.addEventListener("pagehide", () => clearInterval(scoreTimer));

  /* stage.html?preview=pikmin（或 =props）：只畫模型展示，調 3D 模型的時候用。
     正式活動不會帶這個參數。 */
  const previewKind = new URLSearchParams(location.search).get("preview");
  const preview = previewKind === "pikmin" || previewKind === "props" ? previewKind : null;

  /* 每幀花了多少毫秒（平滑過）。在投影幕那台的開發者工具裡打 __p100perf
     就看得到，判斷那台電腦跑不跑得動用的。 */
  const perf = { frameMs: 0 };
  (window as unknown as { __p100perf: typeof perf }).__p100perf = perf;
  // 除錯用：開發者工具裡打 __p100field.actors 就看得到每個人的搖桿、搖動數
  (window as unknown as { __p100field: typeof field }).__p100field = field;

  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const workStart = performance.now();

    surface.ctx.fillStyle = "#14141A";
    surface.ctx.fillRect(0, 0, surface.w, surface.h);

    if (preview) {
      drawPreview(surface.ctx, surface.w, surface.h, now, preview);
      flushPikmin(surface.ctx);
    } else {
      game?.step(dt, now, ctx);
      game?.draw(now, ctx);
      // 關卡自己沒 flush 的 3D 皮克敏，在這裡補畫上去
      flushPikmin(surface.ctx);
      if (showLeaderboard) drawLeaderboard();
    }

    perf.frameMs = perf.frameMs * 0.9 + (performance.now() - workStart) * 0.1;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /** 全場總排行榜。主控台按一下就蓋上來，是頒獎的那個畫面。 */
  /** L 鍵的覆蓋層：只排四個隊伍（個人分數在主控台的計分表） */
  function drawLeaderboard(): void {
    const { ctx: g, w, h, unit } = surface;
    const totals: Record<string, number> = {};
    for (const id of TEAM_IDS) totals[id] = 0;
    for (const r of scoreRows()) totals[r.team] = (totals[r.team] ?? 0) + r.total;
    const rows = [...TEAM_IDS].sort((x, y) => (totals[y] ?? 0) - (totals[x] ?? 0));

    g.fillStyle = "rgba(10,10,14,.93)";
    g.fillRect(0, 0, w, h);

    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#F2A72C";
    g.font = `900 ${Math.round(unit * 8)}px system-ui, "Noto Sans TC", sans-serif`;
    g.fillText("隊伍排行榜", w / 2, unit * 12);

    const top = Math.max(1, totals[rows[0] ?? "A"] ?? 0);
    rows.forEach((id, i) => {
      const y = unit * (32 + i * 14);
      const barW = w * 0.45 * ((totals[id] ?? 0) / top);
      const t = TEAMS[id];

      g.textAlign = "right";
      g.fillStyle = "rgba(255,255,255,.55)";
      g.font = `900 ${Math.round(unit * 6)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(`${i + 1}`, w * 0.14, y);

      g.textAlign = "left";
      g.fillStyle = "#FFFFFF";
      g.font = `900 ${Math.round(unit * 4.4)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(`${t.name}・${t.pikmin}`, w * 0.16, y);

      g.fillStyle = t.color;
      g.fillRect(w * 0.42, y - unit * 3, Math.max(unit, barW), unit * 6);

      g.fillStyle = "#FFFFFF";
      g.fillText(`${totals[id] ?? 0}`, w * 0.42 + Math.max(unit, barW) + unit * 2, y);
    });
  }

  function applyKey(e: KeyboardEvent): void {
    // 遊戲先挑走自己要的鍵（換題目、開球…），沒吃掉才輪到主流程。
    if (game?.key?.(e, ctx)) return;

    switch (e.key) {
      case "ArrowRight":
        go(index + 1);
        break;
      case "ArrowLeft":
        go(index - 1);
        break;
      case "l":
      case "L":
        setLeaderboard(!showLeaderboard);
        break;
      case "f":
      case "F":
        void (document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen());
        break;
      case "Escape":
        $("menu").classList.toggle("open");
        break;
    }
  }

  window.addEventListener("keydown", (e) => {
    applyKey(e);
    if (e.key.startsWith("Arrow") || e.key === " ") e.preventDefault();
  });

  $("menu").addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("li");
    if (!li) return;
    go([...$("menu").children].indexOf(li));
    $("menu").classList.remove("open");
  });
}

void main();
