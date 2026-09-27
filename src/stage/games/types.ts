/* ============================================================
   小遊戲介面

   每個遊戲拿到同一個 ctx：玩家的世界（Field）、畫布、以及一個
   publish() 用來把「手機上要顯示什麼」送出去。

   設計上的一條線：遊戲不准直接碰傳輸層。要讓手機知道的事情一律走
   publish()，而且只能放很小的東西 —— 它會乘以人數變成下行。
   即時座標留在 Field 裡就好，投影幕才需要看到。
   ============================================================ */

import type { GeoItem, PlayerAction, RoomState } from "../../net/schema";
import type { BgmStyle, Sfx } from "../audio";
import type { Surface } from "../canvas";
import type { Field } from "../render";

export interface GameContext {
  readonly field: Field;
  readonly surface: Surface;
  /** 送到手機上。內容要小，而且只在真的變了的時候呼叫才有意義。 */
  publish(patch: Partial<RoomState>): void;

  /**
   * 把各隊的座標交出去，伺服器會按隊分流，每支手機只收自己那一隊的。
   * 已節流到 4 Hz，可以放心每幀呼叫。
   */
  publishPins(pins: Record<string, [number, number][]>): void;

  /**
   * 從場地喇叭放一個音效。只有投影幕出聲，手機不出聲。
   * 太密的同種音效會被吞掉（見 audio.ts），所以放心在每一次事件都叫。
   */
  sfx(name: Sfx): void;

  /**
   * 右上角 QR 的左緣在畫布上的 x（畫布像素）。QR 收起來時是畫布寬度。
   *
   * QR 的大小是用 rem 和 vw 訂的，畫面卻是照比例排的 ——
   * 寫死「右邊留 24%」在 1080p 剛好，在 4:3 的投影機上就會被蓋住。
   * 要避開 QR 的版面問這個，不要自己猜。
   */
  qrLeft(): number;

  /** 左上角 HUD（關卡名）的下緣在畫布上的 y。要避開它的版面問這個。 */
  hudBottom(): number;
}

export interface Game {
  readonly id: string;
  /** 投影幕上的標題 */
  readonly title: string;
  /** 主持人提示，開場前按 Esc 看得到 */
  readonly brief: string;

  /**
   * 這一關要不要把右上角的 QR 收起來。
   *
   * QR 平常該留著（遲到的人隨時可以掃），但有些關卡的畫面會用到
   * 右上角那一塊 —— 地理達人的地圖就整個被蓋住。
   */
  readonly hideQr?: boolean;

  /**
   * 卡通主題（主視覺 group.png 的天空草地風格）。
   * 這種關卡要自己把整個背景畫滿，HUD 也會換成亮底用的樣式。
   * 沒標的關卡維持深色底 —— 它們的文字色都是照深底挑的。
   */
  readonly cartoon?: boolean;

  /** 這一關放哪一首背景音樂。沒寫就是遊戲中的那首。 */
  readonly bgm?: BgmStyle;

  /** 進到這一關。負責把 field 重設、把第一句提示 publish 出去。 */
  enter(ctx: GameContext): void;

  /** 每幀。dt 是秒，已經夾在 0.1 以內（分頁切回來不會爆衝）。 */
  step(dt: number, now: number, ctx: GameContext): void;

  /** 每幀。玩家的點由遊戲自己決定什麼時候畫，才排得出前後層次。 */
  draw(now: number, ctx: GameContext): void;

  /**
   * 玩家的一次性事件（拍到的顏色、翻面的時間）。
   * 只有需要的遊戲才實作。
   */
  action?(uid: string, action: PlayerAction, ctx: GameContext): void;

  /**
   * 主持人按鍵。回傳 true 代表這個鍵被吃掉了，主流程不要再處理。
   * 慣例：T = 開始／暫停這一局，R = 重來。
   */
  key?(e: KeyboardEvent, ctx: GameContext): boolean;

  /**
   * 主控台的「開始」「暫停」。跟 T 的差別是它講的是目標狀態，不是切換，
   * 所以按幾次都一樣 —— 指令重送或手滑按兩下不會把剛開始的一局關掉。
   *
   * @returns 有沒有接受。公布型的關卡（地理、找不同、拍照、選邊站）
   *          沒有「暫停」這個概念，收到 on=false 就回 false，
   *          主控台會據此告訴主持人「這一關不能暫停」。
   */
  run?(on: boolean, ctx: GameContext): boolean;

  /** 這一局現在跑著沒有。主控台靠它把按鈕顯示成實際的狀態。 */
  running?(): boolean;

  /** 主控台調數值設定（例如賽跑一圈要幾下）。 */
  setting?(key: string, value: number): void;

  /** 主控台改題庫（目前只有地理達人用得到）。 */
  setGeoList?(list: GeoItem[], ctx: GameContext): void;

  /** 主控台換某一題的照片。dataUri 留空 = 拿掉。 */
  setGeoPhoto?(index: number, dataUri: string): void;

  /** 離開這一關時清東西。 */
  exit?(ctx: GameContext): void;
}
