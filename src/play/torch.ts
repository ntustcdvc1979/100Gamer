/* ============================================================
   手電筒（火候達人的「烤箱焗烤」用）

   一百支手機在同一秒亮起來，那是這一關唯一一個全場看得到的畫面 ——
   其他幾道菜的動作都發生在各自手上，只有這一道會讓整個場地亮一下。

   ⚠️ 不是每支手機都開得了。

   真正的閃光燈要 MediaStreamTrack 的 torch 約束，而那個目前只有
   Android Chrome 系列支援；iOS Safari 到現在都不給網頁碰閃光燈。
   所以一定要有退路：開不了就把整個畫面轉成全白最亮 ——
   在暗的場地裡，一百片白色螢幕其實比一百顆閃光燈還亮。

   另外它需要相機權限（torch 掛在攝影機的軌道上），使用者會看到
   「要使用相機」的提示。這件事要先講，不然現場會有人以為在偷拍。
   ============================================================ */

export type TorchKind = "torch" | "screen";

export interface Torch {
  /** 真的開起來了沒，以及是用哪一種。 */
  readonly kind: TorchKind | null;
  /** 開燈。回傳實際用的方式。一定要從使用者的點擊裡呼叫。 */
  turnOn(): Promise<TorchKind>;
  /** 關燈，順便把相機放掉 —— 相機開著不關，指示燈會一直亮。 */
  turnOff(): void;
}

/**
 * torch 不在標準的 MediaTrackConstraintSet 型別裡（它是廠商擴充），
 * 所以要自己轉一次型別才傳得進去。
 */
type TorchConstraints = MediaTrackConstraints & { advanced?: { torch: boolean }[] };

export function createTorch(screen: HTMLElement): Torch {
  let track: MediaStreamTrack | null = null;
  let stream: MediaStream | null = null;
  let kind: TorchKind | null = null;

  async function tryRealTorch(): Promise<boolean> {
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      const t = stream.getVideoTracks()[0];
      if (!t) return false;
      // 有些裝置沒有 torch 這個能力，applyConstraints 會直接丟出來
      await t.applyConstraints({ advanced: [{ torch: true }] } as TorchConstraints);
      track = t;
      return true;
    } catch {
      // 權限被拒、沒有後鏡頭、不支援 torch —— 都走退路
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      return false;
    }
  }

  return {
    get kind() {
      return kind;
    },

    async turnOn() {
      if (kind) return kind;
      kind = (await tryRealTorch()) ? "torch" : "screen";
      if (kind === "screen") screen.classList.add("torchOn");
      return kind;
    },

    turnOff() {
      if (track) {
        void track.applyConstraints({ advanced: [{ torch: false }] } as TorchConstraints).catch(() => {
          /* 關不掉就直接停掉軌道 */
        });
      }
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      track = null;
      screen.classList.remove("torchOn");
      kind = null;
    },
  };
}
