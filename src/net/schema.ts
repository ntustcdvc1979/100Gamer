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

  /** 這一關手機該用哪一種操作介面。沒填就是搖桿。 */
  control?: "joystick" | "camera" | "flip";

  /** 這一輪還收不收（拍照／翻面）。時間到之後手機要自己鎖起來。 */
  accepting?: boolean;

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
}

/* ---------- 一次性動作：手機 → 投影幕 ---------- */

/** 拍照找顏色：手機自己算完顏色，只送結果。照片不上傳。 */
export interface ColorAction {
  k: "color";
  /** 拍到的顏色 #rrggbb */
  hex: string;
  /** 手機端算好的分數 0–100，投影幕會自己再算一次確認 */
  score: number;
}

/** 火候達人：翻面的時刻（距離這一題開始幾毫秒）。 */
export interface FlipAction {
  k: "flip";
  ms: number;
  /** 是用陀螺儀還是按鈕。現場想知道有多少人的感測器沒作用。 */
  by: "motion" | "tap";
}

export type PlayerAction = ColorAction | FlipAction;

/* ---------- 指令：主控台 → 投影幕 ---------- */

export type Command =
  /** 換到第 n 關 */
  | { k: "goto"; index: number }
  /** 等同主持人在投影幕上按某個鍵（T 開始、R 重來、→ 下一題…） */
  | { k: "key"; key: string }
  /** 投影幕上叫出／收起總排行榜 */
  | { k: "leaderboard"; on: boolean }
  /** 把所有人的總分歸零 */
  | { k: "resetScores" };

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
