/* ============================================================
   搖動偵測（熱血拔河／熱血賽跑／拔蘿蔔用）

   判定方式：合成加速度的長度偏離重力多少。靜止時約 9.8，
   甩一下會衝高再回落，所以看「超過門檻 → 掉回門檻以下」算一下。

   為什麼不看單軸：手拿著的角度每個人都不一樣，有人上下甩、
   有人左右甩，看單軸會漏掉一半的人。合成長度對姿勢不敏感。

   為什麼要有冷卻時間：一次揮動的加速度曲線不是乾淨的一個峰，
   中間會抖。沒有冷卻的話一下會被算成三四下，搖得快的人分數爆掉。
   80ms 對應大約每秒 12 下，比人手甩得動的極限還寬一點。

   計數是**累計**的，不歸零。手機每次送 input 就把目前的累計值帶上去，
   投影幕自己算差值 —— 中間掉幾筆訊息都補得回來。
   ============================================================ */

const THRESHOLD = 4.0;
const COOLDOWN_MS = 80;
const GRAVITY = 9.81;

export interface ShakeCounter {
  /** 到目前為止總共搖了幾下。 */
  readonly count: number;
  /** 最近有沒有真的收到感測器事件。手機端要顯示「已偵測到感應器」。 */
  readonly sensing: boolean;
  /**
   * 切換判定方式。
   *   shake 任何方向的強烈晃動（拔河、賽跑）
   *   pull  比較用力、比較慢的一拉（拔蘿蔔）
   */
  setMode(mode: "shake" | "pull"): void;
  dispose(): void;
}

/**
 * 拉的門檻比搖高、冷卻比搖長。
 *
 * 人手往上拔一根蘿蔔大概 3–4 下/秒就是極限，跟甩手的 12 下/秒差很多。
 * 用同一組參數的話，狂甩的人會被當成在狂拉，這一關就變成另一個搖手機。
 */
/**
 * 5 而不是 7。
 *
 * 7 m/s²（約 0.7g）要很用力地甩才碰得到，但「把手機往上拔」是一個
 * 比較沉、比較慢的動作，實際大概只有 0.3–0.5g。門檻訂在 7 的結果是
 * 認真在拉的人一根都拔不到，計數整場停在 0。
 *
 * 擋「狂甩的人被當成在拉」主要靠的是冷卻時間（220ms ≈ 每秒最多 4.5 下），
 * 不是門檻高低，所以降門檻不會讓這一關退化成另一個搖手機。
 */
const PULL_THRESHOLD = 5;
const PULL_COOLDOWN_MS = 220;

export function createShakeCounter(): ShakeCounter {
  let count = 0;
  let armed = true;
  let lastAt = 0;
  let mode: "shake" | "pull" = "shake";
  // -1e9 而不是 0：performance.now() 在開頁後的頭兩秒本來就小於 2000，
  // 初始值放 0 的話「最近有沒有收到事件」在那兩秒會一律成立，
  // 於是沒有感測器的手機一進來會先騙人說「已偵測到」。
  let lastEventAt = -1e9;

  function onMotion(e: DeviceMotionEvent): void {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    const mag = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);
    // 桌機與模擬器會送全 0 的讀數。那不是「自由落體」，是根本沒有感測器：
    //   1. 不擋掉的話 |0 - 9.81| 每一筆都超過門檻，計數會自己一直跳。
    //   2. 這種事件也不該算「感應器活著」—— 玩家要知道的是
    //      「我能不能用搖的」，不是「有沒有事件進來」。
    if (mag < 1) return;
    lastEventAt = performance.now();
    const delta = Math.abs(mag - GRAVITY);
    const now = performance.now();
    const threshold = mode === "pull" ? PULL_THRESHOLD : THRESHOLD;
    const cooldown = mode === "pull" ? PULL_COOLDOWN_MS : COOLDOWN_MS;
    if (armed && delta > threshold && now - lastAt > cooldown) {
      count++;
      lastAt = now;
      armed = false;
    } else if (!armed && delta < threshold * 0.5) {
      // 掉回來才重新武裝，一個峰只算一下
      armed = true;
    }
  }

  window.addEventListener("devicemotion", onMotion);

  return {
    get count() {
      return count;
    },
    get sensing() {
      // 2 秒內有收到事件就算感測器活著。iOS 沒給權限的話一則都不會來。
      return performance.now() - lastEventAt < 2000;
    },
    setMode(m) {
      mode = m;
    },
    dispose() {
      window.removeEventListener("devicemotion", onMotion);
    },
  };
}

/* ============================================================
   往下滑計數（熱血拔河用）

   為什麼拔河改成滑不是搖：拔河的體感是「往自己這邊拉」，那是一個
   有方向的動作；搖手機沒有方向，四隊一起亂甩看起來都一樣。
   而且滑動不吃感測器權限 —— 沒給權限、或手機根本沒有加速度計的人，
   在這一關不會整場動不了。

   判定：手指往下移動累積超過一段距離就算一下，然後把錨點移到目前位置，
   所以一路往下滑會連續計數，往上回拉不會倒扣（只是把錨點帶上去）。
   ============================================================ */

/** 往下滑多少像素算一下。用視窗高度的比例，大小螢幕手感才一致。 */
const SWIPE_FRACTION = 0.12;

export interface SwipeCounter {
  readonly count: number;
  /** 這一關要不要吃觸控。不是這一關的時候要關掉，不然會亂數。 */
  setActive(on: boolean): void;
  dispose(): void;
}

export function createSwipeCounter(surface: HTMLElement): SwipeCounter {
  let count = 0;
  let active = false;
  /** 目前這根手指的錨點 y。null = 沒有手指按著。 */
  let anchor: number | null = null;
  let pointer: number | null = null;

  const step = (): number => Math.max(40, window.innerHeight * SWIPE_FRACTION);

  function onDown(e: PointerEvent): void {
    if (!active || pointer !== null) return;
    pointer = e.pointerId;
    anchor = e.clientY;
    try {
      surface.setPointerCapture(e.pointerId);
    } catch {
      /* 抓不到就算了 */
    }
  }

  function onMove(e: PointerEvent): void {
    if (!active || e.pointerId !== pointer || anchor === null) return;
    const dy = e.clientY - anchor;
    if (dy >= step()) {
      // 一次滑很長要算很多下，不然快速長滑會吃虧
      const n = Math.floor(dy / step());
      count += n;
      anchor += n * step();
    } else if (dy < 0) {
      // 往上回拉只是把錨點帶上去，不倒扣 —— 來回滑本來就是這個動作的一部分
      anchor = e.clientY;
    }
  }

  function onUp(e: PointerEvent): void {
    if (e.pointerId !== pointer) return;
    pointer = null;
    anchor = null;
  }

  surface.addEventListener("pointerdown", onDown);
  surface.addEventListener("pointermove", onMove);
  surface.addEventListener("pointerup", onUp);
  surface.addEventListener("pointercancel", onUp);

  return {
    get count() {
      return count;
    },
    setActive(on) {
      active = on;
      if (!on) {
        pointer = null;
        anchor = null;
      }
    },
    dispose() {
      surface.removeEventListener("pointerdown", onDown);
      surface.removeEventListener("pointermove", onMove);
      surface.removeEventListener("pointerup", onUp);
      surface.removeEventListener("pointercancel", onUp);
    },
  };
}
