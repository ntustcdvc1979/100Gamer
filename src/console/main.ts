/* ============================================================
   主控台 —— 主持人的遙控器

   它不是第二個投影幕，只是遙控器：所有邏輯與分數都在 stage 那邊，
   這裡送指令、收計分表。stage 才是真相來源。

   ⚠️ 身分驗證的真正防線不在這支檔案。

   這裡的 Google 登入只是「拿到一張 token」。能不能控制投影幕是
   server/index.js 的 verifyConsole() 說了算 —— 它會驗簽章、驗
   audience、驗 email_verified，再比對 ALLOWED_EMAILS。
   前端自己 if (email === "...") 是裝飾品，打開 devtools 就繞過了。

   所以這一頁「看起來」能不能操作不重要，真的送出去的指令
   伺服器會再擋一次。
   ============================================================ */

import "../shared/base.css";
import "./console.css";
import { AccessDenied, openRoom, type Room } from "../net/room";
import { TEAMS } from "../shared/teams";
import type { ScoreRow } from "../net/schema";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** 順序與 id 都要跟 stage/games/index.ts 一致。 */
const GAMES = [
  { id: "gather", title: "聚沙成塔", note: "全體協作・搖桿" },
  { id: "tugofwar", title: "四方拔河", note: "分組對抗・搖桿" },
  { id: "pickside", title: "選邊站", note: "個人賽・搖桿" },
  { id: "shaketug", title: "搖拔河", note: "紅vs黃、綠vs藍・搖手機" },
  { id: "geo", title: "地理達人", note: "個人賽・點地圖・30 秒" },
  { id: "findchar", title: "文字找不同", note: "個人賽・30 秒" },
  { id: "shakerun", title: "熱血賽跑", note: "團體賽・搖手機" },
  { id: "photocolor", title: "拍照找顏色", note: "個人賽・60 秒" },
  { id: "shakecarrot", title: "拔蘿蔔", note: "分組對抗・拉手機・1 分鐘" },
  { id: "heatmaster", title: "火候達人", note: "個人賽・六道菜" },
  { id: "finale", title: "總排行榜", note: "頒獎・一個一個揭曉" },
];

interface GoogleCredentialResponse {
  credential: string;
}

interface GoogleAccounts {
  accounts: {
    id: {
      initialize(o: {
        client_id: string;
        callback: (r: GoogleCredentialResponse) => void;
      }): void;
      renderButton(el: HTMLElement, o: Record<string, unknown>): void;
    };
  };
}

function loadGoogle(): Promise<GoogleAccounts> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => {
      const g = (window as unknown as { google?: GoogleAccounts }).google;
      g ? resolve(g) : reject(new Error("Google 登入載入失敗"));
    };
    s.onerror = () => reject(new Error("Google 登入載入失敗"));
    document.head.appendChild(s);
  });
}

/**
 * 先問伺服器有沒有開驗證。
 *
 * 少了這一步，「前端沒設 client id」和「帳號沒權限」在畫面上長得一樣：
 * 都是停在登入頁。但前者根本不會有按鈕可以按，跟人說「你沒有權限」
 * 只會讓他在現場對著空白畫面找登入按鈕。
 *
 * @returns true/false，問不到回 null
 */
async function serverRequiresAuth(wsUrl: string): Promise<boolean | null> {
  if (!wsUrl) return null;
  try {
    const http = wsUrl.replace(/^ws/, "http");
    const res = await fetch(new URL("/health", http), { cache: "no-store" });
    const json = (await res.json()) as { auth?: boolean };
    return json.auth === true;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // 只有這一頁用得到，所以直接在這裡讀，不放進 SETTINGS ——
  // SETTINGS 會被 Node 的腳本 import，碰 import.meta.env 會爆。
  //
  // 真正的防線在 server/index.js 的 verifyConsole()，這裡只負責拿一張 token。
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
  const wsUrl = import.meta.env.VITE_WS_URL ?? "";
  const needsAuth = await serverRequiresAuth(wsUrl);

  if (needsAuth === true && !clientId) {
    // 最容易踩到的組合：伺服器鎖了，網站卻長不出登入按鈕。
    // 直接把要補的東西寫在畫面上，不要讓人去猜。
    $("gbtn").innerHTML =
      '<div class="setup">' +
      "<b>這個網站還沒設定 Google 登入</b>" +
      "<p>伺服器已經開啟驗證，但網站少了 <code>VITE_GOOGLE_CLIENT_ID</code>，" +
      "所以登入按鈕出不來。要補的是：</p>" +
      "<ol>" +
      "<li>GitHub repo → Settings → Secrets and variables → Actions → " +
      "<b>Variables</b> 分頁（不是 Secrets）→ 新增 <code>VITE_GOOGLE_CLIENT_ID</code></li>" +
      "<li>Actions → Deploy to GitHub Pages → <b>Run workflow</b> 重跑一次</li>" +
      "</ol>" +
      "<p>值要跟伺服器的 <code>GOOGLE_CLIENT_ID</code> 一樣。詳細步驟見 docs/SETUP.md。</p>" +
      "<p>來不及的話，直接用投影幕那台筆電的鍵盤操作，功能完全一樣。</p>" +
      "</div>";
    return;
  }

  if (!clientId) {
    // 兩邊都沒設 = 開發模式，直接進去。進去之後會有一條常駐警告 ——
    // 只在登入頁閃一下就被蓋掉的訊息等於沒有。
    await connect(undefined, true);
    return;
  }

  const google = await loadGoogle().catch((e) => {
    $("authNote").textContent = String(e.message ?? e);
    return null;
  });
  if (!google) return;

  google.accounts.id.initialize({
    client_id: clientId,
    callback: (res) => void connect(res.credential),
  });
  google.accounts.id.renderButton($("gbtn"), {
    theme: "outline",
    size: "large",
    locale: "zh_TW",
  });
}

async function connect(token?: string, insecure = false): Promise<void> {
  let room: Room;
  try {
    room = await openRoom("console", { token });
  } catch (e) {
    if (e instanceof AccessDenied) {
      $("authNote").textContent = e.message;
    } else {
      $("authNote").textContent = `連不上：${(e as Error).message}`;
    }
    return;
  }

  $("login").hidden = true;
  $("panel").hidden = false;
  // 沒有驗證的話要一直看得到，不能只在登入頁閃一下。
  $("insecure").hidden = !insecure;

  const statusEl = $("status");
  const statusText = $("statusText");
  room.onConnection((ok) => {
    statusEl.classList.toggle("on", ok);
    statusText.textContent = ok ? "已連線" : "連線中斷";
  });

  /* ---- 關卡選擇 ---- */
  const list = $("games");
  list.innerHTML = GAMES.map(
    (g, i) =>
      `<li data-i="${i}"><b>${i + 1}</b><span class="t">${g.title}</span><span class="n">${g.note}</span></li>`,
  ).join("");
  list.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("li");
    if (!li) return;
    const i = Number(li.dataset.i);
    room.sendCommand({ k: "goto", index: i });
    [...list.children].forEach((el, j) => el.classList.toggle("on", i === j));
  });

  // 投影幕是真相來源：它換關卡（例如有人在投影幕上按鍵）時，
  // 這裡要跟著亮，不能只信自己按過什麼。
  room.onState((s) => {
    const g = GAMES.find((x) => x.id === s?.game);
    $("nowGame").textContent = s?.game ? `${g?.title ?? s.game}　第 ${s.round} 回合` : "—";
    $("nowHint").textContent = s?.hint ?? "";
    // 投影幕上有人直接按鍵換關卡時，左邊的清單也要跟著亮 ——
    // 主控台不能只信自己按過什麼，投影幕才是真相來源。
    [...list.children].forEach((el, j) => el.classList.toggle("on", GAMES[j]?.id === s?.game));
  });

  /* ---- 按鈕 ---- */
  const key = (k: string) => () => room.sendCommand({ k: "key", key: k });
  $("btnStart").addEventListener("click", key("t"));
  $("btnNext").addEventListener("click", key("ArrowRight"));
  $("btnPrev").addEventListener("click", key("ArrowLeft"));
  $("btnReset").addEventListener("click", key("r"));

  let boardOn = false;
  $("btnBoard").addEventListener("click", () => {
    boardOn = !boardOn;
    room.sendCommand({ k: "leaderboard", on: boardOn });
    $("btnBoard").classList.toggle("on", boardOn);
    $("btnBoard").textContent = boardOn
      ? "🏆 收起排行榜"
      : "🏆 投影幕顯示排行榜";
  });

  $("btnZero").addEventListener("click", () => {
    if (!confirm("把所有人的總分歸零？這個動作不能復原。")) return;
    room.sendCommand({ k: "resetScores" });
  });

  /* ---- 熱血賽跑：一圈要幾下 ---- */
  $("btnPerLap").addEventListener("click", () => {
    const v = Number($<HTMLInputElement>("perLap").value);
    if (!Number.isFinite(v) || v < 100) return;
    room.sendCommand({ k: "setting", key: "perLap", value: v });
    $("btnPerLap").textContent = "已套用";
    setTimeout(() => ($("btnPerLap").textContent = "套用"), 1200);
  });

  /* ---- 地理達人題庫 ---- */
  setupGeoEditor(room);

  /* ---- 剔除玩家 ---- */
  // 綁在 tbody 上而不是每一列 —— 計分表每半秒整個重畫，
  // 綁在按鈕上的 listener 會跟著被丟掉。
  $("tbody").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".kick");
    if (!btn) return;
    const uid = btn.dataset.uid;
    const who = btn.dataset.name ?? "";
    if (!uid) return;
    if (!confirm(`把「${who}」請出遊戲？他要重新掃 QR 才能再進來。`)) return;
    room.sendCommand({ k: "kick", uid });
  });

  /* ---- 計分表 ---- */
  room.onScores((rows: ScoreRow[]) => {
    $("count").textContent = String(rows.length);
    const scored = rows.filter((r) => r.total > 0);
    $("tbody").innerHTML =
      rows.length === 0
        ? `<tr><td colspan="6" class="empty">還沒有人加入</td></tr>`
        : rows
            .map((r, i) => {
              const t = TEAMS[r.team];
              return `<tr>
                <td class="rank">${r.total > 0 ? i + 1 : "—"}</td>
                <td class="name">${escapeHtml(r.name)}</td>
                <td><span class="chip" style="background:${t?.color ?? "#888"}">${t?.name ?? r.team}</span></td>
                <td class="num">${r.round || ""}</td>
                <td class="num total">${r.total}</td>
                <td><button class="kick" data-uid="${r.uid}" data-name="${escapeHtml(r.name)}" title="把這個人請出去">✕</button></td>
              </tr>`;
            })
            .join("");
    $("scored").textContent = String(scored.length);
  });
}

/** 名字是玩家自己打的，直接塞進 innerHTML 會是 XSS。 */
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}

void main();

/* ============================================================
   地理達人的題庫編輯器

   文字和照片分開送：
     geoList   整包文字，改一個字就重送全部（很小，無所謂）
     geoPhoto  一次一張照片，只在真的換圖時送

   綁在一起的話，改一個地名就要把所有照片重傳一次 ——
   七張壓過的圖也有幾百 KB，在現場的網路上會卡住。

   照片在這裡就先壓過再送，不是原檔：手機拍的原圖動輒好幾 MB，
   而投影幕上只佔半個畫面，800px 就綽綽有餘。
   ============================================================ */

interface GeoRow {
  name: string;
  hint: string;
  lon: number;
  lat: number;
  /** 已經壓過的 data URI，空字串 = 沒有照片 */
  photo: string;
  /** 這一張換過沒，決定要不要重送 */
  dirty: boolean;
}

/** 預設題庫。要跟 src/config/geo.ts 一致，改那邊記得也改這邊。 */
const DEFAULT_GEO: GeoRow[] = [
  { name: "飛機巷", hint: "看飛機降落的那條巷子", lon: 121.2205, lat: 25.0755, photo: "", dirty: false },
  { name: "台北 101", hint: "", lon: 121.5645, lat: 25.034, photo: "", dirty: false },
  { name: "日月潭", hint: "", lon: 120.915, lat: 23.857, photo: "", dirty: false },
  { name: "阿里山", hint: "", lon: 120.803, lat: 23.511, photo: "", dirty: false },
  { name: "太魯閣", hint: "", lon: 121.622, lat: 24.158, photo: "", dirty: false },
  { name: "鵝鑾鼻燈塔", hint: "台灣最南端", lon: 120.851, lat: 21.902, photo: "", dirty: false },
  { name: "台科大", hint: "我們學校", lon: 121.5405, lat: 25.0135, photo: "", dirty: false },
];

const GEO_KEY = "p100:geo";
/** 投影幕上只佔半個畫面，800px 綽綽有餘。 */
const PHOTO_MAX = 800;

function setupGeoEditor(room: Room): void {
  /** 有沒有存過（主持人真的編輯過）。沒編輯過就不用推，預設值本來就在程式裡。 */
  let stored = false;
  let rows: GeoRow[] = load();

  function load(): GeoRow[] {
    try {
      const raw = localStorage.getItem(GEO_KEY);
      if (raw) {
        stored = true;
        return JSON.parse(raw) as GeoRow[];
      }
    } catch {
      /* 壞掉就用預設的 */
    }
    return DEFAULT_GEO.map((r) => ({ ...r }));
  }

  function save(): void {
    stored = true;
    try {
      localStorage.setItem(GEO_KEY, JSON.stringify(rows));
    } catch {
      // 照片塞滿 localStorage 是會發生的事（一張 100KB × 七張）。
      // 存不下就算了，題目還在記憶體裡，這一場跑得完。
      console.warn("[p100] 題庫存不進 localStorage，可能是照片太多");
    }
  }

  function render(): void {
    $("geoList").innerHTML = rows
      .map(
        (r, i) => `
        <div class="geoItem" data-i="${i}">
          <div class="line">
            <input type="text" class="name" data-f="name" value="${esc(r.name)}" placeholder="地名">
            <button class="del" data-del="${i}">刪</button>
          </div>
          <div class="line">
            <input type="text" data-f="hint" value="${esc(r.hint)}" placeholder="提示（可留空）">
          </div>
          <div class="line">
            <input type="number" data-f="lon" step="0.0001" value="${r.lon}" placeholder="經度">
            <input type="number" data-f="lat" step="0.0001" value="${r.lat}" placeholder="緯度">
          </div>
          <div class="pic">
            ${r.photo ? `<img src="${r.photo}" alt="">` : "<span>沒有照片</span>"}
            <label class="fileBtn">選照片
              <input type="file" accept="image/*" data-photo="${i}" hidden>
            </label>
          </div>
        </div>`,
      )
      .join("");
  }

  $("geoList").addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    const item = el.closest<HTMLElement>(".geoItem");
    const field = el.dataset.f;
    if (!item || !field) return;
    const row = rows[Number(item.dataset.i)];
    if (!row) return;
    if (field === "lon" || field === "lat") row[field] = Number(el.value);
    else if (field === "name" || field === "hint") row[field] = el.value;
    save();
  });

  $("geoList").addEventListener("click", (e) => {
    const del = (e.target as HTMLElement).dataset.del;
    if (del === undefined) return;
    rows.splice(Number(del), 1);
    save();
    render();
  });

  $("geoList").addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    const idx = el.dataset.photo;
    if (idx === undefined) return;
    const file = el.files?.[0];
    el.value = "";
    if (!file) return;
    void (async () => {
      const row = rows[Number(idx)];
      if (!row) return;
      row.photo = await shrink(file);
      row.dirty = true;
      save();
      render();
      // 馬上送出去，主持人才看得到投影幕變了
      room.sendCommand({ k: "geoPhoto", index: Number(idx), dataUri: row.photo });
      row.dirty = false;
    })();
  });

  $("btnGeoAdd").addEventListener("click", () => {
    rows.push({ name: "新地點", hint: "", lon: 121.0, lat: 23.5, photo: "", dirty: false });
    save();
    render();
  });

  $("btnGeoSave").addEventListener("click", () => {
    room.sendCommand({
      k: "geoList",
      list: rows.map((r) => ({ name: r.name, hint: r.hint, lon: r.lon, lat: r.lat })),
    });
    // 換題庫會把投影幕那邊的照片清掉，所以有圖的都要重送
    rows.forEach((r, i) => {
      if (r.photo) room.sendCommand({ k: "geoPhoto", index: i, dataUri: r.photo });
    });
    $("btnGeoSave").textContent = "已套用";
    setTimeout(() => ($("btnGeoSave").textContent = "套用到投影幕"), 1400);
  });

  render();

  /* 主控台連上就把自己存的題庫推上去。
     伺服器重啟時它自己的記憶會清空，主控台的 localStorage 是更深一層的備份。
     投影幕那邊「內容一樣就不動」，所以這個自動推送不會打斷進行中的那一題。 */
  if (stored) {
    room.sendCommand({
      k: "geoList",
      list: rows.map((r) => ({ name: r.name, hint: r.hint, lon: r.lon, lat: r.lat })),
    });
    rows.forEach((r, i) => {
      if (r.photo) room.sendCommand({ k: "geoPhoto", index: i, dataUri: r.photo });
    });
  }
}

/** 壓縮照片。長邊 PHOTO_MAX、JPEG 0.75。 */
async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PHOTO_MAX / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bitmap.width * scale);
  c.height = Math.round(bitmap.height * scale);
  c.getContext("2d")?.drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close();
  return c.toDataURL("image/jpeg", 0.75);
}

function esc(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
