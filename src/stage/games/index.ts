/* ============================================================
   遊戲清單與流程順序

   這個順序是刻意的，一場派對的起承轉合。
   節奏在「坐著」與「站起來」之間交替，不要連續兩關都在狂搖：

     1  聚沙成塔    全體協作。學會用搖桿，看到大家都在線上
     2  四方拔河    分組對抗。搖桿，吵
     3  選邊站      個人賽。全場大遷徙，喘一口氣
     4  搖拔河      分組對抗。第一次狂搖，最吵的一關
     5  地理達人    個人賽。坐下來動腦
     6  文字找不同  個人賽。安靜但緊張
     7  搖賽跑      個人賽。再站起來
     8  拍照找顏色  個人賽。離開座位去找東西，換一個身體節奏
     9  拔蘿蔔      分組對抗。一分鐘，全場最後一次爆發
    10  火候達人    個人賽。收尾，最後一個人的名字留在投影幕上

   不用全部跑完 —— 主控台可以跳關。十關全開大約 50 分鐘。

   要加新遊戲就實作 types.ts 的 Game 介面，加進下面的陣列。
   加之前先想一下延遲：端到端約 60ms，不要做需要精準時序判定的
   （誰先按、節奏、瞄準）—— 那些在百人場會變成純運氣。

   火候達人和文字找不同看起來像在測時序，其實不是：
   前者比的是「玩家自己抓的 10 秒」跟真正的 10 秒差多少，
   後者是幾秒級的反應，60ms 對它們都不影響。
   ============================================================ */

import { createFindCharGame } from "./findchar";
import { createGatherGame } from "./gather";
import { createGeoGame } from "./geo";
import { createHeatMasterGame } from "./heatmaster";
import { createPhotoColorGame } from "./photocolor";
import { createPickSideGame } from "./pickside";
import { createShakeCarrotGame, createShakeRunGame, createShakeTugGame } from "./shake";
import { createTugOfWarGame } from "./tugofwar";
import type { Game } from "./types";

export function createGames(): Game[] {
  return [
    createGatherGame(),
    createTugOfWarGame(),
    createPickSideGame(),
    createShakeTugGame(),
    createGeoGame(),
    createFindCharGame(),
    createShakeRunGame(),
    createPhotoColorGame(),
    createShakeCarrotGame(),
    createHeatMasterGame(),
  ];
}

export type { Game, GameContext } from "./types";
