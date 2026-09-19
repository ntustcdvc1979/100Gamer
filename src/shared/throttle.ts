/**
 * 節流送出。
 *
 * 這是整個架構最重要的一支：100 人 × 10 Hz = 每秒 1000 次寫入，會直接把
 * Realtime Database 打爆。所以手機端不是「一有動作就送」，而是把最新的值
 * 蓋在暫存裡，固定間隔送一次最後的狀態。
 *
 * 用「蓋掉」而不是「排隊」是刻意的 —— 搖桿只有最新的位置有意義，
 * 中間漏掉的那幾格沒人在乎。
 */
export function throttleLatest<T>(
  hz: number,
  send: (value: T) => void,
): { push: (value: T) => void; flush: () => void; stop: () => void } {
  const interval = 1000 / hz;
  let pending: { v: T } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function tick() {
    if (!pending) return;
    const { v } = pending;
    pending = null;
    send(v);
  }

  timer = setInterval(tick, interval);

  return {
    push(value: T) {
      pending = { v: value };
    },
    flush: tick,
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
