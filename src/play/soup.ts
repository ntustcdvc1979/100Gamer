/* ============================================================
   端湯（火候達人的最後一道）

   手機是一碗湯。碗會自己往隨機的方向偏，玩家要反向傾斜手機把它拉回來。
   撐到時間到，剩越多湯分數越高。

   為什麼整段模擬跑在手機上、只回報一個結果：
   傾斜角度是每秒幾十筆的資料，乘以一百支手機就是規則一在防的那種扇出。
   而投影幕並不需要看到每一個人的碗晃成什麼樣 —— 它只要知道最後剩多少。

   為什麼用 deviceorientation 而不是 devicemotion：
   這一關要的是「手機現在傾斜幾度」，那正是 orientation 給的東西；
   加速度計要自己積分才能得到角度，而積分會飄。
   （其他關卡相反：它們要的是「有沒有動」，那用加速度計才對。）

   沒有感測器的人怎麼辦：退回用手指拖曳。這一關沒有「按一下就完成」的
   備援可言，但拖曳至少讓他玩得到，而且拖曳並不會比傾斜容易 ——
   兩邊都要一直盯著碗做微調。
   ============================================================ */

/**
 * 湯面傾斜超過這個角度就開始灑（度）。
 *
 * 這三個常數是一組的，調的時候要一起看。目標是：
 * 什麼都不做的人 20 秒之後大概剩兩三成，
 * 認真跟著把手機傾回來的人可以守住八成以上 —— 分數才有鑑別度。
 */
const SPILL_ANGLE = 18;
/** 灑出去的速度：完全翻倒時每秒掉幾 %。 */
const SPILL_RATE = 30;
/** 干擾每隔多久換一次方向（毫秒）。 */
const GUST_EVERY_MS = 1400;
/**
 * 干擾的最大幅度（度）。
 *
 * 一定要明顯大於 SPILL_ANGLE，不然「放著不動」幾乎不會灑 ——
 * 那這一關就變成大家都滿分，分數沒有意義。
 * 38 度的意思是：什麼都不做大概有一半的時間在灑，
 * 而玩家能施加的角度是 ±45 度，所以認真拉是拉得回來的。
 */
const GUST_MAX = 38;

export interface Soup {
  /** 還剩多少湯，0..100。 */
  readonly left: number;
  /** 碗現在歪幾度（含干擾與玩家的傾斜），給畫面用。 */
  readonly tilt: number;
  /** 有沒有真的收到感測器事件。 */
  readonly sensing: boolean;
  /** 開一局。 */
  start(): void;
  /** 每幀推進。dt 是秒。 */
  step(dt: number): void;
  /** 沒有感測器時用手指拖曳，-1..1。 */
  setManual(v: number): void;
  dispose(): void;
}

export function createSoup(): Soup {
  let left = 100;
  /** 玩家的傾斜（度，左右） */
  let player = 0;
  /** 目前的干擾方向（度） */
  let gust = 0;
  /** 下一次換干擾方向的時間 */
  let nextGustAt = 0;
  /** 干擾要飄過去的目標角度 */
  let gustTarget = 0;
  let manual = 0;
  let lastEventAt = -1e9;
  let running = false;

  const sensing = (): boolean => performance.now() - lastEventAt < 2000;
  /** 玩家實際施加的角度。沒有感測器就用拖曳，-1..1 對應 ±45 度。 */
  const applied = (): number => (sensing() ? player : manual * 45);

  function onOrient(e: DeviceOrientationEvent): void {
    // gamma 是左右傾斜，-90..90。橫著拿的人 gamma 會很大，夾一下就好。
    if (typeof e.gamma !== "number") return;
    lastEventAt = performance.now();
    player = Math.max(-45, Math.min(45, e.gamma));
  }

  window.addEventListener("deviceorientation", onOrient);

  return {
    get left() {
      return left;
    },
    get tilt() {
      // 玩家往哪邊傾就把碗往回拉，所以是相減
      return gust - applied();
    },
    get sensing() {
      return sensing();
    },

    start() {
      left = 100;
      gust = 0;
      nextGustAt = 0;
      running = true;
    },

    step(dt) {
      if (!running) return;
      const now = performance.now();

      /* 干擾：每隔一段時間換一個隨機方向，中間平滑地過去。
         直接跳的話碗會瞬移，玩家來不及反應只會覺得是壞掉。 */
      if (now >= nextGustAt) {
        nextGustAt = now + GUST_EVERY_MS * (0.6 + Math.random() * 0.8);
        gustTarget = (Math.random() * 2 - 1) * GUST_MAX;
      }
      gust += (gustTarget - gust) * Math.min(1, dt * 2.5);

      const over = Math.abs(gust - applied()) - SPILL_ANGLE;
      if (over > 0) {
        // 歪越多灑越快，但有上限，不然一翻過去就瞬間見底
        left = Math.max(0, left - SPILL_RATE * Math.min(1, over / 30) * dt);
      }
    },

    setManual(v) {
      manual = Math.max(-1, Math.min(1, v));
    },

    dispose() {
      running = false;
      window.removeEventListener("deviceorientation", onOrient);
    },
  };
}

