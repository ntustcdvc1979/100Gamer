/* ============================================================
   輸入層：虛擬搖桿

   為什麼觸控是主要輸入、體感只是加分項：
   iOS 13 之後 DeviceOrientation 必須在使用者點擊的 handler 裡呼叫
   requestPermission()，而且一旦被拒絕就要重新載入頁面才能再問一次。
   100 人裡只要 10% 卡在這裡，現場就是 10 個人同時舉手。
   所以預設走觸控，體感等主玩法穩了再當彩蛋加上去。
   ============================================================ */

export interface Joystick {
  /** 目前的向量，兩軸都在 -1..1。沒按住的時候是 [0, 0]。 */
  readonly value: [number, number];
  dispose(): void;
}

export function createJoystick(pad: HTMLElement, knob: HTMLElement): Joystick {
  const value: [number, number] = [0, 0];
  let active: number | null = null;
  let origin = { x: 0, y: 0 };
  let radius = 80;

  function place(dx: number, dy: number): void {
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function onDown(e: PointerEvent): void {
    if (active !== null) return;
    active = e.pointerId;
    const rect = pad.getBoundingClientRect();
    // 搖桿的圓心就是手指按下的地方，不是 pad 的正中央 ——
    // 這樣不用看畫面也能操作，玩家可以一直盯著投影幕。
    origin = { x: e.clientX, y: e.clientY };
    radius = Math.min(rect.width, rect.height) / 2.4;
    try {
      pad.setPointerCapture(e.pointerId);
    } catch {
      /* 抓不到就算了，pad 是全螢幕的，手指跑出去的機會不大 */
    }
    place(0, 0);
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerId !== active) return;
    let dx = e.clientX - origin.x;
    let dy = e.clientY - origin.y;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) {
      dx = (dx / dist) * radius;
      dy = (dy / dist) * radius;
    }
    place(dx, dy);
    value[0] = dx / radius;
    value[1] = dy / radius;
  }

  function onUp(e: PointerEvent): void {
    if (e.pointerId !== active) return;
    active = null;
    value[0] = 0;
    value[1] = 0;
    place(0, 0);
  }

  pad.addEventListener("pointerdown", onDown);
  pad.addEventListener("pointermove", onMove);
  pad.addEventListener("pointerup", onUp);
  pad.addEventListener("pointercancel", onUp);

  return {
    value,
    dispose() {
      pad.removeEventListener("pointerdown", onDown);
      pad.removeEventListener("pointermove", onMove);
      pad.removeEventListener("pointerup", onUp);
      pad.removeEventListener("pointercancel", onUp);
    },
  };
}
