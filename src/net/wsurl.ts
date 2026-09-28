/* ============================================================
   遊戲伺服器的網址，以及「現在是哪一種連線模式」

   兩種連線模式，同一份程式碼、同一份 build：

     A 各自網路（預設）  網站在 GitHub Pages、伺服器在 Fly.io 東京，
                        玩家用自己的行動網路。
     B 區網              網站和伺服器都在現場那台筆電上（npm run host），
                        玩家連現場的 mesh Wi-Fi。

   分辨方式很簡單：這一頁是從哪裡載進來的。
   從區網位址（192.168.x.x、10.x.x.x…）用 http 載進來的，就是 B，
   伺服器一定是同一台（local-host.mjs 會把 WebSocket 轉過去）；
   其他情況就是 A，連 VITE_WS_URL 設的雲端伺服器。

   為什麼不做成「網頁上一個開關，切了就改連另一台伺服器」：
   A 的網頁是 HTTPS，瀏覽器會擋掉 HTTPS 頁面連 ws:// 的區網位址
   （mixed content），區網 IP 又拿不到憑證。所以切模式一定是
   「整個網頁換到另一個地方去開」—— 主控台上的切換按鈕做的就是這件事，
   見 console/main.ts 與 stage/main.ts 的 netMode。
   ============================================================ */

export type NetMode = "A" | "B";

/**
 * 模式 A 的網站在哪裡。從 B 切回 A 的時候，投影幕、主控台、手機
 * 都要跳回這個網址。可以用 VITE_PUBLIC_SITE 覆寫（例如換了網域）。
 */
export const PUBLIC_SITE: string =
  (import.meta.env.VITE_PUBLIC_SITE as string | undefined) || "https://ntustcdvc1979.github.io/100Gamer/";

/** 私有網段／本機的主機名稱 */
function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local")) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * 這一頁是不是從現場那台筆電（區網）載進來的。
 * 開發模式（npm run dev）不算 —— 那時候 Vite 自己的 dev server 不會轉 WebSocket。
 */
export function isLanOrigin(): boolean {
  return import.meta.env.PROD && location.protocol === "http:" && isPrivateHost(location.hostname);
}

/** 目前是哪一種連線模式 */
export function currentNetMode(): NetMode {
  return isLanOrigin() ? "B" : "A";
}

/** 這個網站的根目錄（結尾有 /），用來組 stage.html／play.html／console.html 的網址 */
export function siteBase(): string {
  return location.href.replace(/[^/]*([?#].*)?$/, "");
}

/** 使用者打的區網位址整理成「http://主機:port/」的樣子 */
export function normalizeLanBase(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.port) u.port = "8080";
    return `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}

/** 把 VITE_WS_URL 解析成真正要連的位址。沒設就回空字串（＝降級到 Firebase／本機）。 */
export function resolveWsUrl(): string {
  const raw = (import.meta.env.VITE_WS_URL ?? "").trim();
  // 區網模式，或是明講 auto：連回這一頁的同一個來源
  if (raw === "auto" || isLanOrigin()) {
    // http→ws、https→wss。混用會被瀏覽器擋掉（mixed content）。
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}`;
  }
  return raw;
}
