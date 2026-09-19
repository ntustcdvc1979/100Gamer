/* ============================================================
   資料模型

   誰寫什麼（這三條規則不能違反，違反了 100 人一定卡死）：

     1. 手機只寫自己的 players/$uid 與 inputs/$uid，只讀 state。
        永遠不訂閱 players 或 inputs —— 那是 O(n²) 扇出。
     2. 只有投影幕做全域訂閱。它是唯一看得到所有人的客戶端，
        也負責所有運算與渲染。
     3. state 要小、要低頻。總下行 ≈ 人數 × state 大小 × 更新頻率，
        即時座標絕對不能放進 state，那只存在投影幕的記憶體裡。
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
  /** 心跳。手機靠它判斷投影幕還活著。 */
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

export function emptyState(): RoomState {
  return {
    phase: "lobby",
    game: "",
    round: 0,
    startedAt: 0,
    teams: {},
    seq: 0,
    updatedAt: Date.now(),
  };
}
