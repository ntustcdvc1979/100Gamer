/* ============================================================
   遊戲伺服器的網址

   兩種跑法，同一份程式碼：

     VITE_WS_URL=wss://xxx.fly.dev   平常：網站在 GitHub Pages、伺服器在 Fly.io
     VITE_WS_URL=auto                現場自架：網站和伺服器在同一台筆電上

   "auto" 的意思是「跟這一頁同一個來源」。之所以需要這個值，是因為現場自架時
   網址是筆電的區網 IP，build 的當下不會知道 —— 寫死就得每換一個場地重 build 一次。
   （scripts/local-host.mjs 會把 WebSocket 轉給同一個 port，所以同源一定對得上。）
   ============================================================ */

/** 把 VITE_WS_URL 解析成真正要連的位址。沒設就回空字串（＝降級到 Firebase／本機）。 */
export function resolveWsUrl(): string {
  const raw = (import.meta.env.VITE_WS_URL ?? "").trim();
  if (raw !== "auto") return raw;

  // http→ws、https→wss。混用會被瀏覽器擋掉（mixed content）。
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}
