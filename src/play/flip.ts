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

export interface FlipWatcher {
  /** 開始一輪。翻面時呼叫 onFlip，單位是距離 start() 幾毫秒。 */
  start(onFlip: (ms: number, by: "motion") => void): void;
  stop(): void;
  dispose(): void;
}

export function watchFlip(): FlipWatcher {
  let armed = false;
  let sawUp = false;
  let startedAt = 0;
  let cb: ((ms: number, by: "motion") => void) | null = null;

  function onMotion(e: DeviceMotionEvent): void {
    if (!armed) return;
    const z = e.accelerationIncludingGravity?.z;
    if (typeof z !== "number") return;

    // 要先看到「朝上」才算數，不然一開始就拿反的人會馬上觸發
    if (z > UP) {
      sawUp = true;
      return;
    }
    if (sawUp && z < DOWN) {
      armed = false;
      cb?.(performance.now() - startedAt, "motion");
    }
  }

  window.addEventListener("devicemotion", onMotion);

  return {
    start(onFlip) {
      cb = onFlip;
      startedAt = performance.now();
      sawUp = false;
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
