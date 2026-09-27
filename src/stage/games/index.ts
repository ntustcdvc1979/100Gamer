/* ============================================================
   遊戲清單與流程順序

   這一場（四象星座 × 皮克敏）實際要玩的是前面這一段，照順序按 → 就對了：

     1  等待大廳    開場。掃 QR 選隊，加入的人變成皮克敏在草地上走
     2  地理達人    個人賽。坐下來動腦
     3  拔蘿蔔      分組對抗。一分鐘，全場第一次爆發
     4  熱血賽跑    團體賽。再站起來
     5  火候達人    個人賽。八道菜，收在端湯
     6  總排行榜    頒獎。從第十名往上一個一個揭曉，可以停著讓大家拍照

   後面那幾關這次沒排，但留著 —— 主控台可以直接點過去，以後別的場次用得到。
   它們擺在頒獎之後，是為了讓主持人一路按 → 的時候不會誤闖進去。
   （這幾關還是舊的深色畫面，沒有換成卡通主題。）

   要加新遊戲就實作 types.ts 的 Game 介面，加進下面的陣列，
   而且 console/main.ts 的 GAMES 要照同一個順序補上 —— 兩邊是用索引對的。

   加之前先想一下延遲：端到端約 60ms，不要做需要精準時序判定的
   （誰先按、節奏、瞄準）—— 那些在百人場會變成純運氣。
   火候達人看起來像在測時序，其實不是：它比的是「玩家自己抓的 10 秒」
   跟真正的 10 秒差多少，60ms 不影響。
   ============================================================ */

import { createFindCharGame } from "./findchar";
import { createFinaleGame } from "./finale";
import { createGatherGame } from "./gather";
import { createGeoGame } from "./geo";
import { createHeatMasterGame } from "./heatmaster";
import { createLobbyGame } from "./lobby";
import { createPhotoColorGame } from "./photocolor";
import { createPickSideGame } from "./pickside";
import { createShakeCarrotGame, createShakeRunGame, createShakeTugGame } from "./shake";
import { createTugOfWarGame } from "./tugofwar";
import type { Game } from "./types";

export function createGames(): Game[] {
  return [
    // ---- 這一場的流程 ----
    createLobbyGame(),
    createGeoGame(),
    createShakeCarrotGame(),
    createShakeRunGame(),
    createHeatMasterGame(),
    createFinaleGame(),
    // ---- 這次沒排的 ----
    createGatherGame(),
    createTugOfWarGame(),
    createPickSideGame(),
    createShakeTugGame(),
    createFindCharGame(),
    createPhotoColorGame(),
  ];
}

export type { Game, GameContext } from "./types";
