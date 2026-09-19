/* ============================================================
   遊戲清單與流程順序

   這個順序是刻意的，一場派對的起承轉合：

     1 聚沙成塔  全體協作。沒有輸家，目的是讓 100 個人學會用搖桿，
                 順便讓全場看到「我們真的都在線上」。
     2 四方拔河  分組對抗。這一關最久、最吵，是整場的主軸。
     3 選邊站    個人賽。收尾，最後有一個人的名字留在投影幕上。

   要加新遊戲就實作 types.ts 的 Game 介面，加進下面的陣列。
   加之前先想一下延遲：端到端約 60ms，不要做需要精準時序判定的
   （誰先按、節奏、瞄準）—— 那些在百人場會變成純運氣。
   ============================================================ */

import { createGatherGame } from "./gather";
import { createPickSideGame } from "./pickside";
import { createTugOfWarGame } from "./tugofwar";
import type { Game } from "./types";

export function createGames(): Game[] {
  return [createGatherGame(), createTugOfWarGame(), createPickSideGame()];
}

export type { Game, GameContext } from "./types";
