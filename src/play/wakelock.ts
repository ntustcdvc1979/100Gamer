/**
 * 防止手機在遊戲中途鎖屏。
 *
 * Wake Lock 在 iOS 要 16.4 以上，而且切到背景再切回來會失效，
 * 所以要在 visibilitychange 重新要一次。拿不到就算了 —— 這是體驗問題，
 * 不是功能問題，不值得為它擋住任何人進場。
 */
export function keepAwake(): () => void {
  let lock: WakeLockSentinel | null = null;
  let stopped = false;

  async function acquire(): Promise<void> {
    if (stopped || document.visibilityState !== "visible") return;
    try {
      lock = await navigator.wakeLock?.request("screen");
    } catch {
      /* 不支援或被拒絕，忽略 */
    }
  }

  function onVisible(): void {
    if (document.visibilityState === "visible") void acquire();
  }

  void acquire();
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisible);
    void lock?.release().catch(() => {});
    lock = null;
  };
}
