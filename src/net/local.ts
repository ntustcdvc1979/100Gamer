/* ============================================================
   本機模式：同一台瀏覽器的分頁之間同步（BroadcastChannel + localStorage）

   兩個用途：
     1. 開發時一個人測 —— 開幾個分頁就是幾個玩家。
     2. 現場連不上時的降級路徑，投影幕照樣跑得完。

   身分用 sessionStorage 而不是 localStorage：每個分頁是不同的玩家，
   但重新整理不會變成新的人。websocket 模式下不需要這招（每支手機本來就分開）。

   主控台在這個模式下**不驗身分** —— 本機開發沒有伺服器可以驗，
   而且分頁之間本來就同源。正式環境一定要走 websocket。
   ============================================================ */

import type {
  Command,
  Input,
  Player,
  PlayerAction,
  RoomState,
  ScoreRow,
} from "./schema";
import type { RoomTransport, Unsubscribe } from "./transport";

type Bag<T> = Record<string, T>;

interface Snapshot {
  host: string | null;
  state: RoomState | null;
  players: Bag<Player>;
  inputs: Bag<Input>;
  scores: ScoreRow[];
  seat: number;
}

function emptySnapshot(): Snapshot {
  return { host: null, state: null, players: {}, inputs: {}, scores: [], seat: 0 };
}

function newId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** 不進 snapshot 的一次性訊息，直接在頻道上傳。 */
type Wire =
  | { w: "snap"; v: Snapshot }
  | { w: "action"; uid: string; v: PlayerAction }
  | { w: "cmd"; v: Command };

const KEY = "p100:local";

export function createLocalTransport(): RoomTransport {
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
    post({ w: "snap", v: snap });
    emit(snap);
  }

  let chan: BroadcastChannel | null = null;
  try {
    chan = new BroadcastChannel(KEY);
  } catch {
    chan = null;
  }

  function post(msg: Wire): void {
    chan?.postMessage(msg);
  }

  const stateCbs: ((s: RoomState | null) => void)[] = [];
  const playerCbs: ((p: Bag<Player>) => void)[] = [];
  const inputCbs: ((i: Bag<Input>) => void)[] = [];
  const scoreCbs: ((r: ScoreRow[]) => void)[] = [];
  const actionCbs: ((uid: string, a: PlayerAction) => void)[] = [];
  const commandCbs: ((c: Command) => void)[] = [];

  function safely(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }

  function emit(snap: Snapshot): void {
    for (const cb of stateCbs) safely(() => cb(snap.state));
    for (const cb of playerCbs) safely(() => cb(snap.players));
    for (const cb of inputCbs) safely(() => cb(snap.inputs));
    for (const cb of scoreCbs) safely(() => cb(snap.scores));
  }

  if (chan) {
    chan.onmessage = (ev: MessageEvent<Wire>) => {
      const m = ev.data;
      if (m.w === "snap") emit(m.v);
      else if (m.w === "action") for (const cb of actionCbs) safely(() => cb(m.uid, m.v));
      else if (m.w === "cmd") for (const cb of commandCbs) safely(() => cb(m.v));
    };
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

    async sendAction(action) {
      // 不進 snapshot：一次性事件被後面的快照蓋掉就消失了
      post({ w: "action", uid, v: action });
      for (const cb of actionCbs) safely(() => cb(uid, action));
    },

    onActions(cb) {
      return sub(actionCbs, cb);
    },

    sendCommand(cmd) {
      post({ w: "cmd", v: cmd });
      for (const cb of commandCbs) safely(() => cb(cmd));
    },

    onCommand(cb) {
      return sub(commandCbs, cb);
    },

    publishScores(rows) {
      const snap = read();
      snap.scores = rows;
      write(snap);
    },

    onScores(cb) {
      const un = sub(scoreCbs, cb);
      cb(read().scores);
      return un;
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
