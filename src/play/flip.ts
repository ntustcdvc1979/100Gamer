/* ============================================================
   翻面偵測（火候達人用）

   用加速度計的 z 軸，不是陀螺儀的角速度積分。
   螢幕朝上時重力在 z 軸上是 +9.8，朝下是 -9.8，中間穿過 0。
   看「有沒有從明顯朝上變成明顯朝下」就好 ——

     積分角速度會飄，而且每支手機的軸向定義不一樣，
     校正不完。重力方向是唯一到處都一致的參考。

   ⚠️ iOS 13 以後一定要在使用者點擊的 handler 裡呼叫 requestPermission()，
   而且**拒絕之後要重新載入頁面才能再問**。所以呼叫端一定要提供
   「按這裡代表翻面」的備援按鈕，不能讓任何人卡在這一關。
   ============================================================ */

/** 超過這個值算「明顯朝上」，低於負的算「明顯朝下」。留死區避免抖動誤判。 */
const UP = 6;
const DOWN = -6;

/**
 * 「提起來」的判定門檻（m/s²）。
 *
 * 靜止時 accelerationIncludingGravity 的長度就是重力，約 9.8。
 * 往上提會多出一段向上的加速度，合成長度會衝過 9.8。
 * 用「長度偏離重力多少」而不是看某一個軸，是因為手拿著的角度不固定 ——
 * 有人平舉、有人斜著拿，看單軸會漏判。
 */
const LIFT_DELTA = 4.5;
/** 晃動要比提起來更用力才算，不然拿起來看一眼就誤判成「撒胡椒粉」。 */
const SHAKE_DELTA = 8;
const GRAVITY = 9.81;

export type FlipSupport = "granted" | "denied" | "unsupported";

interface MotionEventCtor {
  requestPermission?: () => Promise<"granted" | "denied">;
}

/**
 * 要感測器權限。一定要從使用者的點擊事件裡呼叫。
 * iOS 以外的裝置通常直接回 granted。
 */
export async function requestMotion(): Promise<FlipSupport> {
  if (typeof DeviceMotionEvent === "undefined") return "unsupported";
  const ctor = DeviceMotionEvent as unknown as MotionEventCtor;
  if (typeof ctor.requestPermission !== "function") {
    // Android Chrome 走這條，不需要權限
    return "granted";
  }
  try {
    return (await ctor.requestPermission()) === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

/** 三種動作：翻面（煎）、提起來（炸物起鍋／掀鍋蓋）、晃動（撒調味料）。 */
export type Gesture = "flip" | "lift" | "shake";

export interface MotionWatcher {
  /** 開始一輪。做出動作時呼叫 onDone，單位是距離 start() 幾毫秒。 */
  start(gesture: Gesture, onDone: (ms: number) => void): void;
  /**
   * 最近有沒有真的收到感測器事件。
   *
   * 不能只看「權限拿到了沒」—— 有些手機權限給了卻不送事件（模擬器、
   * 桌機瀏覽器、省電模式）。現場要讓人在開始前就知道自己是不是
   * 得改用按鈕，而不是等到動作做完才發現沒送出去。
   */
  readonly sensing: boolean;
  stop(): void;
  dispose(): void;
}

export function watchMotion(): MotionWatcher {
  let armed = false;
  let gesture: Gesture = "flip";
  let sawUp = false;
  let settled = false;
  let startedAt = 0;
  let cb: ((ms: number) => void) | null = null;
  // 見 shake.ts：初始 0 會讓開頁後兩秒謊報「已偵測到感應器」
  let lastEventAt = -1e9;

  function fire(): void {
    armed = false;
    cb?.(performance.now() - startedAt);
  }

  function onMotion(e: DeviceMotionEvent): void {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    // 不管有沒有在計時都要記，「感測器活著沒」跟「這一輪開始了沒」是兩件事
    lastEventAt = performance.now();
    if (!armed) return;

    if (gesture === "flip") {
      const z = a.z;
      if (typeof z !== "number") return;
      // 要先看到「朝上」才算數，不然一開始就拿反的人會馬上觸發
      if (z > UP) {
        sawUp = true;
        return;
      }
      if (sawUp && z < DOWN) fire();
      return;
    }

    // lift 與 shake 都看合成加速度偏離重力多少，只是門檻不同：
    // 提起來是一個比較緩的推力，晃動是比較猛的來回。
    const mag = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
    if (mag < 1) return;
    const delta = Math.abs(mag - GRAVITY);
    // 一開始要先「安穩放著」一次，不然剛按完開始、手還在晃就觸發
    if (!settled) {
      if (delta < 1.5) settled = true;
      return;
    }
    if (delta > (gesture === "shake" ? SHAKE_DELTA : LIFT_DELTA)) fire();
  }

  window.addEventListener("devicemotion", onMotion);

  return {
    get sensing() {
      return performance.now() - lastEventAt < 2000;
    },
    start(g, onDone) {
      gesture = g;
      cb = onDone;
      startedAt = performance.now();
      sawUp = false;
      settled = false;
      armed = true;
    },
    stop() {
      armed = false;
    },
    dispose() {
      armed = false;
      window.removeEventListener("devicemotion", onMotion);
    },
  };
}
