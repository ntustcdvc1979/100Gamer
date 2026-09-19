/* ============================================================
   本機模式：同一台瀏覽器的分頁之間同步（BroadcastChannel + localStorage）

   兩個用途：
     1. 開發時一個人測 —— 開幾個分頁就是幾個玩家。
     2. 現場 Firebase 連不上時的降級路徑，投影幕照樣跑得完。

   身分用 sessionStorage 而不是 localStorage：每個分頁是不同的玩家，
   但重新整理不會變成新的人。firebase 模式下不需要這招（每支手機本來就分開）。
   ============================================================ */

import type { Input, Player, RoomState } from "./schema";
import type { RoomTransport, Unsubscribe } from "./transport";

type Bag<T> = Record<string, T>;

interface Snapshot {
  host: string | null;
  state: RoomState | null;
  players: Bag<Player>;
  inputs: Bag<Input>;
  seat: number;
}

function emptySnapshot(): Snapshot {
  return { host: null, state: null, players: {}, inputs: {}, seat: 0 };
}

function newId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function createLocalTransport(room: string): RoomTransport {
  const KEY = `p100:${room}`;
  const UID_KEY = `${KEY}:uid`;

  let uid = "";
  try {
    uid = sessionStorage.getItem(UID_KEY) ?? "";
  } catch {
    /* 無痕模式讀不到，每次都是新的人，可接受 */
  }
  if (!uid) {
    uid = newId();
    try {
      sessionStorage.setItem(UID_KEY, uid);
    } catch {
      /* 存不了就算了 */
    }
  }

  function read(): Snapshot {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return emptySnapshot();
      return { ...emptySnapshot(), ...(JSON.parse(raw) as Partial<Snapshot>) };
    } catch {
      return emptySnapshot();
    }
  }

  function write(snap: Snapshot): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(snap));
    } catch {
      /* 滿了就算了 */
    }
    chan?.postMessage(snap);
    emit(snap);
  }

  let chan: BroadcastChannel | null = null;
  try {
    chan = new BroadcastChannel(KEY);
  } catch {
    chan = null;
  }

  const stateCbs: ((s: RoomState | null) => void)[] = [];
  const playerCbs: ((p: Bag<Player>) => void)[] = [];
  const inputCbs: ((i: Bag<Input>) => void)[] = [];

  function emit(snap: Snapshot): void {
    for (const cb of stateCbs) safely(() => cb(snap.state));
    for (const cb of playerCbs) safely(() => cb(snap.players));
    for (const cb of inputCbs) safely(() => cb(snap.inputs));
  }

  function safely(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }

  if (chan) {
    chan.onmessage = (ev: MessageEvent<Snapshot>) => emit(ev.data);
  }
  // 沒有 BroadcastChannel 的話還有 storage 事件可以撐著
  window.addEventListener("storage", (ev) => {
    if (ev.key === KEY) emit(read());
  });

  function sub<T>(list: T[], cb: T): Unsubscribe {
    list.push(cb);
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  return {
    kind: "local",
    uid,
    connected: true,

    onConnection(cb) {
      cb(true);
      return () => {};
    },

    onState(cb) {
      const un = sub(stateCbs, cb);
      cb(read().state);
      return un;
    },

    async setState(state) {
      const snap = read();
      snap.state = state;
      write(snap);
    },

    async claimHost() {
      const snap = read();
      if (snap.host && snap.host !== uid) return false;
      snap.host = uid;
      write(snap);
      return true;
    },

    onPlayers(cb) {
      const un = sub(playerCbs, cb);
      cb(read().players);
      return un;
    },

    async savePlayer(patch) {
      const snap = read();
      snap.players[uid] = { ...(snap.players[uid] as Player | undefined), ...patch } as Player;
      write(snap);
    },

    onInputs(cb) {
      const un = sub(inputCbs, cb);
      cb(read().inputs);
      return un;
    },

    async sendInput(input) {
      const snap = read();
      snap.inputs[uid] = input;
      write(snap);
    },

    async takeSeat() {
      const snap = read();
      const seat = snap.seat;
      snap.seat = seat + 1;
      write(snap);
      return seat;
    },

    async clearRoom() {
      write(emptySnapshot());
    },
  };
}
