/* ============================================================
   對外的連線 API

   自動降級：遊戲伺服器 → Firebase → 本機模式，投影幕永遠跑得動。
   （沿用 orientation/assets/net.js 驗證過的設計。）

   節流也放在這一層，而不是交給呼叫端自律 —— 這樣送出頻率就是架構保證的，
   不是某個人記得要做的事。實際數字依傳輸層而定，見 config/settings.ts 的 RATES。
   ============================================================ */

import { RATES, SETTINGS } from "../config/settings";
import { throttleLatest } from "../shared/throttle";
import { createFirebaseTransport, type FirebaseOptions } from "./firebase";
import { createLocalTransport } from "./local";
import { createWebsocketTransport } from "./websocket";
import { emptyState, type Input, type Player, type RoomState } from "./schema";
import type { RoomTransport, TransportKind, Unsubscribe } from "./transport";

export type Role = "stage" | "play";

/** 網址上的 ?r= 可以臨時換房號，方便同一天跑兩場不互相干擾。 */
export function roomCode(): string {
  const q = new URLSearchParams(location.search).get("r");
  return (q ?? SETTINGS.room).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

/** 手機端要掃的網址。 */
export function playUrl(): string {
  const base = SETTINGS.playUrl || location.href.replace(/[^/]*$/, "") + "play.html";
  return `${base}${base.includes("?") ? "&" : "?"}r=${roomCode()}`;
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
  readonly code: string;
  readonly role: Role;
  /** stage 才有意義：有沒有搶到 host。沒搶到就不要寫 state。 */
  readonly isHost: boolean;
  readonly connected: boolean;

  onConnection(cb: (ok: boolean) => void): Unsubscribe;
  onState(cb: (state: RoomState | null) => void): Unsubscribe;
  onPlayers(cb: (players: Record<string, Player>) => void): Unsubscribe;
  onInputs(cb: (inputs: Record<string, Input>) => void): Unsubscribe;

  /** stage 用。已節流（見 RATES），可以放心每幀呼叫。 */
  publishState(patch: Partial<RoomState>): void;
  /** 立刻送出，不等節流。換關卡這種一次性的事件用。 */
  publishStateNow(patch: Partial<RoomState>): Promise<void>;

  /** play 用。已節流（見 RATES），可以放心每幀呼叫。 */
  pushInput(v: [number, number]): void;

  savePlayer(patch: Partial<Player>): Promise<void>;
  takeSeat(): Promise<number>;
  clearRoom(): Promise<void>;
  dispose(): void;
}

/**
 * 選傳輸層。順序就是降級順序：
 *
 *   websocket  Fly.io 的遊戲伺服器 —— 主線，搖桿 20 Hz
 *   firebase   備援 —— 伺服器掛了還有得跑，但只有 5 Hz
 *   local      兩個都沒有 —— 同一台電腦的分頁之間同步，投影幕永遠跑得動
 */
async function pickTransport(code: string, role: Role): Promise<RoomTransport> {
  const wsUrl = import.meta.env.VITE_WS_URL;
  if (wsUrl) {
    try {
      return await createWebsocketTransport(code, wsUrl, role);
    } catch (e) {
      console.warn("[p100] 遊戲伺服器連不上，改用 Firebase：", e);
    }
  }

  const cfg = readFirebaseConfig();
  if (cfg) {
    try {
      return await createFirebaseTransport(code, cfg);
    } catch (e) {
      console.warn("[p100] Firebase 也連不上，改用本機模式：", e);
    }
  }

  return createLocalTransport(code);
}

export async function openRoom(role: Role): Promise<Room> {
  const code = roomCode();
  const net = await pickTransport(code, role);
  const rates = RATES[net.kind];

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

  function merge(patch: Partial<RoomState>): RoomState {
    current = { ...current, ...patch, seq: current.seq + 1, updatedAt: Date.now() };
    return current;
  }

  const room: Room = {
    kind: net.kind,
    uid: net.uid,
    code,
    role,
    isHost,
    get connected() {
      return net.connected;
    },

    onConnection: (cb) => net.onConnection(cb),
    onState: (cb) => net.onState(cb),

    onPlayers(cb) {
      if (role !== "stage") {
        throw new Error("只有 stage 可以訂閱 players —— 手機訂閱就是 O(n²) 扇出");
      }
      return net.onPlayers(cb);
    },

    onInputs(cb) {
      if (role !== "stage") {
        throw new Error("只有 stage 可以訂閱 inputs —— 手機訂閱就是 O(n²) 扇出");
      }
      return net.onInputs(cb);
    },

    publishState(patch) {
      if (!isHost) return;
      stateOut.push(merge(patch));
    },

    async publishStateNow(patch) {
      if (!isHost) return;
      const next = merge(patch);
      await net.setState(next).catch((e) => console.warn("[p100] setState 失敗", e));
    },

    pushInput(v) {
      inputOut.push({ v, t: Date.now() });
    },

    savePlayer: (patch) => net.savePlayer(patch),
    takeSeat: () => net.takeSeat(),
    clearRoom: () => net.clearRoom(),

    dispose() {
      stateOut.stop();
      inputOut.stop();
    },
  };

  return room;
}
