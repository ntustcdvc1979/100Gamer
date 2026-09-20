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
  const ctx: GameContext = {
    field,
    surface,
    publish: (patch) => room.publishState(patch),
    publishPins: (pins) => room.publishPins(pins),
  };

  let index = -1;
  let game: Game | null = null;
  let showLeaderboard = false;
  /** 主持人有沒有把 QR 打開。關卡自己也可以要求收起來（hideQr）。 */
  let qrWanted = true;

  function syncQr(): void {
    $("qrPanel").hidden = game?.hideQr === true || !qrWanted;
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
    game.enter(ctx);
    $("gameTitle").textContent = game.title;
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
    $("qrPanel").classList.toggle("small", uids.size > 0);

    // 手機的選隊畫面要看得到哪一隊人少，不然一定有一隊爆滿。
    // 四個數字，只有人進出時才變，放進 state 划算。
    const counts = TEAM_IDS.map(
      (t) => [...field.actors.values()].filter((a) => a.team === t).length,
    );
    room.publishState({ teamCounts: counts });
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

  // 計分表用 setInterval 而不是塞在 rAF 迴圈裡：分頁一被切到背景 rAF 就停，
  // 主控台會整個瞎掉。setInterval 在背景分頁還是會跑（會被降到 1 Hz，
  // 對一張 2 Hz 的計分表完全夠）。
  const scoreTimer = setInterval(() => {
    room.publishScores(scoreRows());
    reportRunning();
  }, 500);
  window.addEventListener("pagehide", () => clearInterval(scoreTimer));

  let last = performance.now();
  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    surface.ctx.fillStyle = "#14141A";
    surface.ctx.fillRect(0, 0, surface.w, surface.h);

    game?.step(dt, now, ctx);
    game?.draw(now, ctx);
    if (showLeaderboard) drawLeaderboard();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /** 全場總排行榜。主控台按一下就蓋上來，是頒獎的那個畫面。 */
  function drawLeaderboard(): void {
    const { ctx: g, w, h, unit } = surface;
    const rows = scoreRows().filter((r) => r.total > 0).slice(0, 10);

    g.fillStyle = "rgba(10,10,14,.93)";
    g.fillRect(0, 0, w, h);

    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#F2A72C";
    g.font = `900 ${Math.round(unit * 8)}px system-ui, "Noto Sans TC", sans-serif`;
    g.fillText("總排行榜", w / 2, unit * 10);

    if (rows.length === 0) {
      g.fillStyle = "rgba(255,255,255,.5)";
      g.font = `700 ${Math.round(unit * 4)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText("還沒有人得分", w / 2, h / 2);
      return;
    }

    const top = rows[0]?.total || 1;
    rows.forEach((r, i) => {
      const y = unit * (22 + i * 7.5);
      const barW = (w * 0.5) * (r.total / top);

      g.textAlign = "right";
      g.fillStyle = "rgba(255,255,255,.55)";
      g.font = `900 ${Math.round(unit * 3.6)}px system-ui, "Noto Sans TC", sans-serif`;
      g.fillText(`${i + 1}`, w * 0.2, y);

      g.textAlign = "left";
      g.fillStyle = "#FFFFFF";
      g.fillText(r.name, w * 0.22, y);

      g.fillStyle = TEAMS[r.team].color;
      g.fillRect(w * 0.4, y - unit * 1.6, barW, unit * 3.2);

      g.fillStyle = "#FFFFFF";
      g.fillText(`${r.total}`, w * 0.4 + barW + unit * 1.5, y);
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
