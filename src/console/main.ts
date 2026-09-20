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
  { id: "gather", title: "聚沙成塔", note: "全體協作・暖身" },
  { id: "tugofwar", title: "四方拔河", note: "分組對抗・主軸" },
  { id: "pickside", title: "選邊站", note: "個人賽" },
  { id: "photocolor", title: "拍照找顏色", note: "個人賽・60 秒" },
  { id: "heatmaster", title: "火候達人", note: "個人賽・翻面" },
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

async function main(): Promise<void> {
  // 只有這一頁用得到，所以直接在這裡讀，不放進 SETTINGS ——
  // SETTINGS 會被 Node 的腳本 import，碰 import.meta.env 會爆。
  //
  // 沒設就跳過登入直接進去（本機開發）。正式環境一定要設，
  // 而且**伺服器那邊也要設同一個**：前端檢查 email 是裝飾品，
  // 真正的防線在 server/index.js 的 verifyConsole()。
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

  if (!clientId) {
    // 開發模式：沒設 client id 就直接進去。伺服器那邊沒設
    // GOOGLE_CLIENT_ID / ALLOWED_EMAILS 的話也會放行，兩邊是一致的。
    $("authNote").textContent = "開發模式：沒有設定 Google 登入，直接進入";
    await connect();
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

async function connect(token?: string): Promise<void> {
  let room: Room;
  try {
    room = await openRoom("console", { token });
  } catch (e) {
    if (e instanceof AccessDenied) {
      $("authNote").textContent = `${e.message}。請換一個有權限的帳號。`;
    } else {
      $("authNote").textContent = `連不上：${(e as Error).message}`;
    }
    return;
  }

  $("login").hidden = true;
  $("panel").hidden = false;

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

  /* ---- 計分表 ---- */
  room.onScores((rows: ScoreRow[]) => {
    $("count").textContent = String(rows.length);
    const scored = rows.filter((r) => r.total > 0);
    $("tbody").innerHTML =
      rows.length === 0
        ? `<tr><td colspan="5" class="empty">還沒有人加入</td></tr>`
        : rows
            .map((r, i) => {
              const t = TEAMS[r.team];
              return `<tr>
                <td class="rank">${r.total > 0 ? i + 1 : "—"}</td>
                <td class="name">${escapeHtml(r.name)}</td>
                <td><span class="chip" style="background:${t?.color ?? "#888"}">${t?.name ?? r.team}</span></td>
                <td class="num">${r.round || ""}</td>
                <td class="num total">${r.total}</td>
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
