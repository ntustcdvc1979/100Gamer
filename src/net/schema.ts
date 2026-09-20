/* ============================================================
   資料模型

   誰寫什麼（這三條規則不能違反，違反了 100 人一定卡死）：

     1. 手機只寫自己的 players/$uid 與 inputs/$uid，只讀 state。
        永遠不訂閱 players 或 inputs —— 那是 O(n²) 扇出。
     2. 只有投影幕做全域訂閱。它是唯一看得到所有人的客戶端，
        也負責所有運算與渲染。
     3. state 要小、要低頻。總下行 ≈ 人數 × state 大小 × 更新頻率，
        即時座標絕對不能放進 state，那只存在投影幕的記憶體裡。

   除了 state 之外還有三條窄通道，都是刻意不走 state 的：

     action    手機 → 投影幕。一次性的事件（拍到的顏色、翻面的時間）。
               不做攤平覆蓋，因為每一筆都不能掉。
     command   主控台 → 投影幕。換關卡、開始、顯示排行榜。
     scores    投影幕 → 主控台。完整計分表，只送給主控台一個人，
               不會廣播給 100 支手機。
   ============================================================ */

import type { TeamId } from "../shared/teams";

export type Phase = "lobby" | "howto" | "playing" | "result";

export interface TeamState {
  score: number;
}

/** stage 寫、所有人讀。每多一個欄位就乘以 100 份下行，加東西前想一下。 */
export interface RoomState {
  phase: Phase;
  /** 目前的小遊戲 id，"" = 還沒選 */
  game: string;
  round: number;
  startedAt: number;
  teams: Partial<Record<TeamId, TeamState>>;

  /**
   * 手機上顯示的一句話。
   *
   * 百人場的大禮堂，後排根本看不清楚投影幕，所以「現在要幹嘛」一定要
   * 出現在自己手機上。但這個字串會乘以人數變成下行，所以要短。
   */
  hint: string;

  /**
   * 選邊站用的四個選項，其他遊戲留空。
   *
   * 這是唯一一個「明知會變大還是放進 state」的欄位：四段短字約 100 bytes，
   * 而且只有換題目時才變。值得，因為後排的人要能在手機上讀到選項。
   */
  options?: string[];

  /** 拍照找顏色：目標色（#rrggbb）。手機要拿它畫色票給玩家看。 */
  targetColor?: string;

  /** 火候達人：這一題要幾秒翻面。手機要拿它顯示倒數。 */
  targetSeconds?: number;

  /**
   * 這一關手機該用哪一種操作介面。
   *
   * 沒填 = 手機上什麼都不顯示，只有一句提示。搖桿不是預設值 ——
   * 大廳、等待、不需要操作的關卡都不該憑空冒出一個搖桿讓人亂推。
   *
   *   joystick  虛擬搖桿
   *   camera    拍照
   *   motion    在指定秒數做一次動作（火候達人），動作看 gesture
   *   shake     一直搖（拔河／跑步／拔蘿蔔）
   *   tap       在台灣地圖上點一個位置（地理達人）
   *   find      在字陣裡找出不一樣的那個字
   */
  control?: "joystick" | "camera" | "motion" | "shake" | "tap" | "find";

  /** control 是 motion 時要做哪一種動作。 */
  gesture?: "flip" | "lift" | "shake";

  /**
   * 各隊現在幾個人。玩家自己選隊，所以要看得到哪一隊人少。
   * 四個數字，約 30 bytes，只有人進出時才變。
   */
  teamCounts?: number[];

  /** 找不同：字陣的亂數種子與行列數。兩邊用同一個種子長出同一張表。 */
  seed?: number;
  rows?: number;
  cols?: number;

  /**
   * 地理達人：這一題的地名。
   *
   * 照片刻意不放進來 —— 它只給投影幕看。一張壓過的照片還是有幾十 KB，
   * 乘以一百支手機就是幾 MB 的下行，而玩家低頭看手機的時候本來就
   * 看不到題目照片（他要看的是地圖）。
   */
  place?: string;

  /** 這一輪還收不收（拍照／翻面）。時間到之後手機要自己鎖起來。 */
  accepting?: boolean;

  /**
   * 這一局在跑沒有。投影幕每幀比對，變了才送。
   *
   * 給主控台用的：主持人手上那支手機要顯示「現在是開始還是暫停」，
   * 而且必須是投影幕回報的真相，不是「我剛剛按了什麼」——
   * 指令掉了的話，後者會騙人。
   */
  running?: boolean;

  /**
   * 拍照找顏色：分數公布了沒。
   *
   * 要跟 accepting 分開，不能用「accepting 從 true 變 false」來推斷：
   * 中途才加入的人沒看過那個轉折，會永遠停在「等公布」。
   */
  revealed?: boolean;

  /** 心跳與變更計數。連線是否還活著看 transport 的 connected。 */
  seq: number;
  updatedAt: number;
}

/** play 寫自己那筆、只有 stage 讀。加入之後幾乎不再變動。 */
export interface Player {
  name: string;
  team: TeamId;
  joinedAt: number;
}

/** play 高頻寫、只有 stage 讀。刻意做得極小 —— 這是流量的主體。 */
export interface Input {
  /** 搖桿向量，兩軸都在 -1..1 */
  v: [number, number];
  /** 送出時的本機時間，用來量延遲與判斷是不是還在動 */
  t: number;
  /**
   * 累計搖了幾下。只有 shake 那幾關會帶。
   *
   * 為什麼送累計值而不是「這次搖了幾下」：input 會被攤平覆蓋，
   * 中間掉幾筆很正常。送增量的話掉一筆就少算幾下；
   * 送累計值的話，投影幕自己算差值，掉多少筆都補得回來。
   */
  s?: number;
}

/* ---------- 一次性動作：手機 → 投影幕 ---------- */

/**
 * 拍照找顏色：拍到的顏色 + 一張縮圖。
 *
 * ⚠️ 縮圖會投在投影幕上給全場看，所以照片確實會離開手機。
 * 這是刻意的取捨（現場要看到大家拍到什麼），代價是：
 *   - 一定要壓成縮圖再送。100 張原圖是幾十 MB，會打爆 256MB 的中繼機。
 *     200px 的 JPEG 約 8–12KB，100 張加起來約 1MB，一次性，沒問題。
 *   - 手機上和 docs 都要明講「會投到大螢幕」，讓人自己決定拍什麼。
 *   - 伺服器只轉不存，投影幕也只留在記憶體，重整就沒了。
 */
export interface ColorAction {
  k: "color";
  /** 拍到的顏色 #rrggbb */
  hex: string;
  /** 縮圖的 data URI。投影幕公布時要秀出來。 */
  thumb: string;
}

/** 火候達人：做動作的時刻（距離這一題開始幾毫秒）。 */
export interface FlipAction {
  k: "flip";
  ms: number;
  /** 是感測器判定的還是按鈕按的。現場想知道有多少支手機的感測器沒作用。 */
  by: "motion" | "tap";
}

/** 地理達人：在台灣地圖上點的位置，0..1 的地圖內座標。 */
export interface TapAction {
  k: "tap";
  x: number;
  y: number;
}

/** 文字找不同：點了第幾格，以及從出題到點下去花了幾毫秒。 */
export interface FindAction {
  k: "find";
  i: number;
  ms: number;
}

export type PlayerAction = ColorAction | FlipAction | TapAction | FindAction;

/* ---------- 指令：主控台 → 投影幕 ---------- */

export type Command =
  /** 換到第 n 關 */
  | { k: "goto"; index: number }
  /** 等同主持人在投影幕上按某個鍵（R 重來、→ 下一題…） */
  | { k: "key"; key: string }
  /**
   * 開始／暫停這一局。
   *
   * 為什麼不沿用 {k:"key", key:"t"}：T 是「切換」。切換的問題是
   * 它的結果取決於現在是什麼狀態，而主持人手上那支手機不見得知道 ——
   * 指令重送一次、或是手滑按兩下，就會把剛開始的一局關掉。
   * 講「我要它跑」而不是「幫我切一下」，按幾次結果都一樣。
   */
  | { k: "run"; on: boolean }
  /** 投影幕上叫出／收起總排行榜 */
  | { k: "leaderboard"; on: boolean }
  /** 投影幕上顯示／隱藏 QR code */
  | { k: "qr"; on: boolean }
  /** 把所有人的總分歸零 */
  | { k: "resetScores" }
  /** 把某個人踢出去。伺服器處理，不是投影幕。 */
  | { k: "kick"; uid: string }
  /** 改一個數值設定，例如賽跑一圈要幾下。 */
  | { k: "setting"; key: string; value: number }
  /** 改地理達人的題庫（文字部分）。 */
  | { k: "geoList"; list: GeoItem[] }
  /**
   * 換掉某一題的照片。跟 geoList 分開送是因為照片大得多 ——
   * 一張壓過的圖幾十 KB，跟文字綁在一起送的話，改一個字就要重傳全部的圖。
   */
  | { k: "geoPhoto"; index: number; dataUri: string };

/** 主控台編輯地理題目時傳的一筆。照片不在裡面。 */
export interface GeoItem {
  name: string;
  hint?: string;
  lon: number;
  lat: number;
}

/* ---------- 計分表：投影幕 → 主控台 ---------- */

export interface ScoreRow {
  uid: string;
  name: string;
  team: TeamId;
  /** 跨關卡累計 */
  total: number;
  /** 這一關拿到的分數 */
  round: number;
}

export function emptyState(): RoomState {
  return {
    phase: "lobby",
    game: "",
    round: 0,
    startedAt: 0,
    teams: {},
    hint: "",
    seq: 0,
    updatedAt: Date.now(),
  };
}
