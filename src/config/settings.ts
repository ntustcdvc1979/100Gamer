/* ============================================================
   活動設定（進 git，這裡沒有任何機密）

   連線設定走環境變數，由 GitHub Actions 寫成 .env.production：
     VITE_WS_URL           遊戲伺服器（Fly.io）—— 主線
     VITE_GOOGLE_CLIENT_ID 主控台登入用的 Google OAuth Client ID
     VITE_FIREBASE_CONFIG  Firebase —— 備援
   詳見 docs/SETUP.md。
   ============================================================ */

import type { TransportKind } from "../net/transport";

export const SETTINGS = {
  /** 手機端網址。留白就用目前網域推算（同一層的 play.html）。 */
  playUrl: "",

  /** 分成幾隊。改這裡的話 TEAMS 也要跟著有足夠的隊伍。 */
  teamCount: 4,
} as const;

// 注意：這支檔案被 Node 的腳本（scripts/fakeplayers.ts）import，
// 所以不可以碰 import.meta.env —— 那在 Node 裡是 undefined，會直接爆。
// 只有瀏覽器用得到的設定放在各自的進入點。

/* ============================================================
   送出頻率

   為什麼分傳輸層設定：這些數字是被後端的計費方式逼出來的，不是憑感覺挑的。

   firebase   每一次寫入都算錢也都算流量，而且 100 人 × 10 Hz 會撞 RTDB 的
              實務上限。5 Hz 是延遲與帳單的平衡點。
   websocket  訊息幾乎免費，伺服器又會把輸入攤平成 60 Hz 的批次再轉給投影幕，
              所以手機端可以放開到 20 Hz。搖桿的手感差別主要來自這裡。
   local      同一台電腦，沒有成本問題。
   ============================================================ */

export const RATES: Record<
  TransportKind,
  { inputHz: number; stateHz: number }
> = {
  firebase: { inputHz: 5, stateHz: 2 },
  websocket: { inputHz: 20, stateHz: 10 },
  local: { inputHz: 20, stateHz: 10 },
};
