/* ============================================================
   對外的連線 API

   自動降級：遊戲伺服器 → Firebase → 本機模式，投影幕永遠跑得動。

   節流也放在這一層，而不是交給呼叫端自律 —— 這樣送出頻率就是架構保證的，
   不是某個人記得要做的事。實際數字依傳輸層而定，見 config/settings.ts 的 RATES。

   沒有房號。一個伺服器一場活動，掃到的 QR 就是入口，
   少一個現場會出錯的環節。
   ============================================================ */

import { RATES, SETTINGS } from "../config/settings";
import { throttleLatest } from "../shared/throttle";
import { createFirebaseTransport, type FirebaseOptions } from "./firebase";
import { createLocalTransport } from "./local";
import { AccessDenied, createWebsocketTransport } from "./websocket";
import {
  emptyState,
  type Command,
  type Input,
  type Player,
  type PlayerAction,
  type RoomState,
  type ScoreRow,
} from "./schema";
import type { Role, RoomTransport, TransportKind, Unsubscribe } from "./transport";

export { AccessDenied };
export type { Role };

/** 手機端要掃的網址。 */
export function playUrl(): string {
  return SETTINGS.playUrl || location.href.replace(/[^/]*$/, "") + "play.html";
}

function readFirebaseConfig(): FirebaseOptions | null {
  const raw = import.meta.env.VITE_FIREBASE_CONFIG;
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw) as Partial<FirebaseOptions>;
    // databaseURL 少了就會安靜地連不上，寧可在這裡明確退回本機模式。
    if (!cfg.apiKey || !cfg.databaseURL) {
      console.warn("[p100] VITE_FIREBASE_CONFIG 缺 apiKey 或 databaseURL，改用本機模式");
      return null;
    }
    return cfg as FirebaseOptions;
  } catch (e) {
    console.warn("[p100] VITE_FIREBASE_CONFIG 不是合法 JSON，改用本機模式", e);
    return null;
  }
}

export interface Room {
  readonly kind: TransportKind;
  readonly uid: string;
  readonly role: Role;
  /** stage 才有意義：有沒有搶到 host。沒搶到就不要寫 state。 */
  readonly isHost: boolean;
  readonly connected: boolean;

  onConnection(cb: (ok: boolean) => void): Unsubscribe;
  onState(cb: (state: RoomState | null) => void): Unsubscribe;
  onPlayers(cb: (players: Record<string, Player>) => void): Unsubscribe;
  onInputs(cb: (inputs: Record<string, Input>) => void): Unsubscribe;
  onActions(cb: (uid: string, action: PlayerAction) => void): Unsubscribe;

  /** stage 用。已節流（見 RATES），可以放心每幀呼叫。 */
  publishState(patch: Partial<RoomState>): void;
  /** 立刻送出，不等節流。換關卡這種一次性的事件用。 */
  publishStateNow(patch: Partial<RoomState>): Promise<void>;

  /**
   * play 用。已節流（見 RATES），可以放心每幀呼叫。
   * shakes 是「到目前為止總共搖了幾下」的累計值，只有 shake 那幾關要帶。
   */
  pushInput(v: [number, number], shakes?: number): void;
  /** play 用。一次性事件，不節流也不覆蓋。 */
  sendAction(action: PlayerAction): Promise<void>;

  /** console 用。 */
  sendCommand(cmd: Command): void;
  /** stage 用。 */
  onCommand(cb: (cmd: Command) => void): Unsubscribe;
  /** stage 用。已節流，不會洗版。 */
  publishScores(rows: ScoreRow[]): void;
  /** console 用。 */
  onScores(cb: (rows: ScoreRow[]) => void): Unsubscribe;

  /** stage 用。已節流到 4 Hz —— 隊友的點不需要 60 fps。 */
  publishPins(pins: Record<string, [number, number][]>): void;
  /** play 用。收到的是自己這一隊的座標。 */
  onPins(cb: (pins: [number, number][]) => void): Unsubscribe;

  savePlayer(patch: Partial<Player>): Promise<void>;
  clearRoom(): Promise<void>;
  dispose(): void;
}

export interface OpenOptions {
  /** 主控台的 Google ID token。伺服器會驗簽章與 email。 */
  token?: string;
}

/**
 * 選傳輸層。順序就是降級順序：
 *
 *   websocket  Fly.io 的遊戲伺服器 —— 主線，搖桿 20 Hz
 *   firebase   備援 —— 伺服器掛了還有得跑，但只有 5 Hz，而且沒有主控台
 *   local      兩個都沒有 —— 同一台電腦的分頁之間同步，投影幕永遠跑得動
 */
async function pickTransport(role: Role, opts: OpenOptions): Promise<RoomTransport> {
  const wsUrl = import.meta.env.VITE_WS_URL;
  if (wsUrl) {
    try {
      return await createWebsocketTransport(wsUrl, role, opts.token);
    } catch (e) {
      // 權限被拒不是連線問題，不該默默降級到一個沒有驗證的模式 —— 直接往上丟。
      if (e instanceof AccessDenied) throw e;
      console.warn("[p100] 遊戲伺服器連不上，改用 Firebase：", e);
    }
  }

  const cfg = readFirebaseConfig();
  if (cfg) {
    try {
      return await createFirebaseTransport(cfg);
    } catch (e) {
      console.warn("[p100] Firebase 也連不上，改用本機模式：", e);
    }
  }

  return createLocalTransport();
}

export async function openRoom(role: Role, opts: OpenOptions = {}): Promise<Room> {
  const net = await pickTransport(role, opts);
  const rates = RATES[net.kind];

  if (role === "console" && !net.sendCommand) {
    throw new Error(
      `主控台不支援 ${net.kind} 模式 —— 它需要伺服器端驗身分。請確認 VITE_WS_URL 有設。`,
    );
  }

  const isHost = role === "stage" ? await net.claimHost() : false;
  if (role === "stage" && !isHost) {
    console.warn("[p100] 這個房間已經有另一台投影幕了，這一台只能觀看。");
  }

  // stage 端維護一份完整的 state，publishState 是「疊上去再送」，
  // 呼叫端不用每次都湊出整包。
  let current: RoomState = emptyState();
  const stateOut = throttleLatest<RoomState>(rates.stateHz, (s) => {
    void net.setState(s).catch((e) => console.warn("[p100] setState 失敗", e));
  });

  const inputOut = throttleLatest<Input>(rates.inputHz, (i) => {
    void net.sendInput(i).catch(() => {
      /* 掉一格輸入無所謂，下一格就補上了 */
    });
  });

  // 計分表比 state 大得多（100 列），但只送給主控台一個人，
  // 所以 2 Hz 就夠，不需要跟畫面同步。
  const scoreOut = throttleLatest<ScoreRow[]>(2, (rows) => net.publishScores?.(rows));

  // 隊友的點：4 Hz 就夠。它是「大家點在哪」的參考，不是即時操作。
  const pinOut = throttleLatest<Record<string, [number, number][]>>(4, (p) =>
    net.publishPins?.(p),
  );

  /** 比內容，不看 seq 與 updatedAt —— 它們每次都會變，拿來比就永遠不相等。 */
  function sameContent(a: RoomState, b: RoomState): boolean {
    const strip = ({ seq: _s, updatedAt: _u, ...rest }: RoomState) => rest;
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  }

  /**
   * @returns null 代表這個 patch 沒有改變任何東西，不用送。
   *
   * 這個檢查是規則 3（state 要小、要低頻）的最後一道防線。遊戲迴圈每幀
   * 呼叫 publishState 是很自然的寫法，沒有這道檢查的話，就算內容一模一樣
   * 也會照著 stateHz 一直送 —— 乘以 100 個收件者就是白燒的頻寬。
   */
  function merge(patch: Partial<RoomState>): RoomState | null {
    const next = { ...current, ...patch };
    if (sameContent(current, next)) return null;
    current = { ...next, seq: current.seq + 1, updatedAt: Date.now() };
    return current;
  }

  const room: Room = {
    kind: net.kind,
    uid: net.uid,
    role,
    isHost,
    get connected() {
      return net.connected;
    },

    onConnection: (cb) => net.onConnection(cb),
    onState: (cb) => net.onState(cb),

    onPlayers(cb) {
      if (role === "play") {
        throw new Error("手機不可以訂閱 players —— 那是 O(n²) 扇出");
      }
      return net.onPlayers(cb);
    },

    onInputs(cb) {
      if (role !== "stage") {
        throw new Error("只有 stage 可以訂閱 inputs —— 那是 O(n²) 扇出");
      }
      return net.onInputs(cb);
    },

    onActions(cb) {
      if (role !== "stage") {
        throw new Error("只有 stage 可以訂閱 actions");
      }
      return net.onActions(cb);
    },

    publishState(patch) {
      if (!isHost) return;
      const next = merge(patch);
      if (next) stateOut.push(next);
    },

    async publishStateNow(patch) {
      if (!isHost) return;
      const next = merge(patch);
      if (!next) return;
      await net.setState(next).catch((e) => console.warn("[p100] setState 失敗", e));
    },

    pushInput(v, shakes) {
      inputOut.push(shakes === undefined ? { v, t: Date.now() } : { v, t: Date.now(), s: shakes });
    },

    sendAction: (action) => net.sendAction(action),

    sendCommand(cmd) {
      net.sendCommand?.(cmd);
    },

    onCommand(cb) {
      return net.onCommand?.(cb) ?? (() => {});
    },

    publishScores(rows) {
      if (!isHost) return;
      scoreOut.push(rows);
    },

    onScores(cb) {
      return net.onScores?.(cb) ?? (() => {});
    },

    publishPins(pins) {
      if (!isHost) return;
      pinOut.push(pins);
    },

    onPins(cb) {
      return net.onPins?.(cb) ?? (() => {});
    },

    savePlayer: (patch) => net.savePlayer(patch),
    clearRoom: () => net.clearRoom(),

    dispose() {
      stateOut.stop();
      inputOut.stop();
      scoreOut.stop();
      pinOut.stop();
    },
  };

  return room;
}
