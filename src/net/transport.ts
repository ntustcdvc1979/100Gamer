/* ============================================================
   傳輸層介面 —— 這是逃生門。

   Firebase Realtime Database 是資料庫，不是遊戲伺服器。用它做即時搖桿
   有三個天花板：端到端延遲約 100–150ms、高頻寫入會撞實務上限、
   流量直接反映在帳單上。所以現在的主線是 websocket.ts（Fly.io 東京），
   Firebase 退成備援。

   這個介面就是當初留的逃生門，而且已經用過一次了 ——
   換傳輸層時 stage/ 和 play/ 一行都沒有改。請維持這個性質：
   遊戲程式只能依賴這個介面，不准直接 import firebase 或 WebSocket。
   ============================================================ */

import type { Input, Player, RoomState } from "./schema";

export type Unsubscribe = () => void;

export type TransportKind = "firebase" | "websocket" | "local";

export interface RoomTransport {
  readonly kind: TransportKind;

  /** 這個客戶端的身分。firebase 模式下是匿名登入的 uid。 */
  readonly uid: string;

  /** 線路現在是不是真的通的。 */
  readonly connected: boolean;

  /** 連線狀態變化。設定填錯時 initializeApp 不會報錯，只有這裡看得出來。 */
  onConnection(cb: (ok: boolean) => void): Unsubscribe;

  /* ---- state：stage 寫，所有人讀 ---- */

  onState(cb: (state: RoomState | null) => void): Unsubscribe;

  /**
   * 只有搶到 host 的 stage 該呼叫。
   * 呼叫頻率請透過 room.publishState 節流，不要直接每幀呼叫。
   */
  setState(state: RoomState): Promise<void>;

  /**
   * 佔住 host 位置。第一個開的 stage 會成功，之後別人改不動 state。
   * @returns 有沒有搶到
   */
  claimHost(): Promise<boolean>;

  /* ---- players：play 寫自己，只有 stage 讀 ---- */

  /** 只有 stage 該呼叫。手機呼叫這個就是把 O(n²) 扇出打開。 */
  onPlayers(cb: (players: Record<string, Player>) => void): Unsubscribe;

  /** 只有 play 該呼叫。會順手掛上 onDisconnect，離線自動從名單消失。 */
  savePlayer(patch: Partial<Player>): Promise<void>;

  /* ---- inputs：play 高頻寫，只有 stage 讀 ---- */

  /** 只有 stage 該呼叫。 */
  onInputs(cb: (inputs: Record<string, Input>) => void): Unsubscribe;

  /** 只有 play 該呼叫。用覆蓋而不是累加，漏掉的中間值沒人在乎。 */
  sendInput(input: Input): Promise<void>;

  /* ---- 其他 ---- */

  /**
   * 拿一個座位號。用 transaction 遞增，100 人同時加入也不會撞號，
   * 隊伍人數因此保證平均（用 uid hash 分隊在 100 人時偏差可能到 ±5）。
   */
  takeSeat(): Promise<number>;

  /** 活動結束或重跑一場：清掉這個房間。 */
  clearRoom(): Promise<void>;
}
