/* ============================================================
   WebSocket 實作 —— 對應 server/index.js

   為什麼值得寫這一支（而不是一直用 Firebase）：
   RTDB 是資料庫，每一次寫入都算錢也都算流量，所以手機端被迫壓在 5 Hz。
   走 WebSocket 之後那個限制消失，搖桿可以拉到 20 Hz ——
   對「每支手機當搖桿」這個玩法，這比延遲從 150ms 降到 50ms 還有感。

   斷線重連是這一支最重要的部分。手機會鎖屏、會走進電梯、會切到別的 app，
   一場 30 分鐘的活動裡 120 支手機一定有人斷過。重連之後要能：
     - 沿用同一個 uid（不然會重新分隊）
     - 自動把玩家資料補送回去（不然他會從投影幕上消失）
     - 投影幕要能重新搶回 host
   ============================================================ */

import type { Input, Player, RoomState } from "./schema";
import type { RoomTransport, Unsubscribe } from "./transport";

type ServerMsg =
  | { t: "welcome"; uid: string; room: string }
  | { t: "state"; v: RoomState | null }
  | { t: "players"; v: Record<string, Player> }
  | { t: "inputs"; v: Record<string, Input> }
  | { t: "seat"; n: number }
  | { t: "host"; ok: boolean };

export async function createWebsocketTransport(
  room: string,
  baseUrl: string,
  role: "stage" | "play",
): Promise<RoomTransport> {
  const UID_KEY = `p100:${room}:uid`;

  // 開發時同一台電腦要開好幾個玩家，?u= 可以強制分身。
  const forced = new URLSearchParams(location.search).get("u");
  let uid = "";
  try {
    uid = forced ? `${localStorage.getItem(UID_KEY) ?? ""}-${forced}` : (localStorage.getItem(UID_KEY) ?? "");
  } catch {
    /* 無痕模式，每次都是新的人，可接受 */
  }

  let sock: WebSocket | null = null;
  let closed = false;
  let connected = false;
  let retry = 0;

  const stateCbs: ((s: RoomState | null) => void)[] = [];
  const playerCbs: ((p: Record<string, Player>) => void)[] = [];
  const inputCbs: ((i: Record<string, Input>) => void)[] = [];
  const connCbs: ((ok: boolean) => void)[] = [];

  let lastState: RoomState | null = null;
  let lastPlayers: Record<string, Player> = {};

  // 重連之後要補回去的東西
  let myPlayer: Partial<Player> | null = null;
  let wantHost = false;

  let seatWaiter: ((n: number) => void) | null = null;
  let hostWaiter: ((ok: boolean) => void) | null = null;

  function url(): string {
    const u = new URL(baseUrl);
    u.searchParams.set("r", room);
    u.searchParams.set("role", role);
    if (uid) u.searchParams.set("uid", uid);
    return u.toString();
  }

  function fire(ok: boolean): void {
    connected = ok;
    for (const cb of connCbs) {
      try {
        cb(ok);
      } catch (e) {
        console.error(e);
      }
    }
  }

  function handle(msg: ServerMsg): void {
    switch (msg.t) {
      case "welcome":
        uid = msg.uid;
        try {
          if (!forced) localStorage.setItem(UID_KEY, uid);
        } catch {
          /* 忽略 */
        }
        fire(true);
        // 重連時把身分補回去。順序很重要：先報到，再搶 host。
        if (myPlayer) send({ t: "player", v: myPlayer });
        if (wantHost) send({ t: "claimHost" });
        break;

      case "state":
        lastState = msg.v;
        for (const cb of stateCbs) cb(msg.v);
        break;

      case "players":
        lastPlayers = msg.v ?? {};
        for (const cb of playerCbs) cb(lastPlayers);
        break;

      case "inputs":
        // 伺服器已經攤平成 20 Hz 的批次，這裡拿到的是「這一輪動過的人」
        for (const cb of inputCbs) cb(msg.v ?? {});
        break;

      case "seat":
        seatWaiter?.(msg.n);
        seatWaiter = null;
        break;

      case "host":
        hostWaiter?.(msg.ok);
        hostWaiter = null;
        break;
    }
  }

  function send(msg: object): void {
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify(msg));
    }
  }

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = new WebSocket(url());
      sock = s;

      s.onmessage = (ev) => {
        try {
          handle(JSON.parse(ev.data as string) as ServerMsg);
        } catch {
          /* 壞掉的訊息直接丟掉，下一則就好 */
        }
      };

      s.onopen = () => {
        retry = 0;
        resolve();
      };

      s.onerror = () => {
        if (s.readyState !== WebSocket.OPEN) reject(new Error("WebSocket 連不上"));
      };

      s.onclose = () => {
        fire(false);
        if (closed) return;
        // 退避重連。上限 5 秒 —— 活動進行中不能讓人等太久，
        // 但也不能一直重打把伺服器壓垮。
        retry = Math.min(retry + 1, 10);
        const wait = Math.min(250 * 2 ** retry, 5000);
        setTimeout(() => {
          if (!closed) void connect().catch(() => {});
        }, wait);
      };
    });
  }

  await connect();

  function sub<T>(list: T[], cb: T): Unsubscribe {
    list.push(cb);
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  return {
    kind: "websocket",
    get uid() {
      return uid;
    },
    get connected() {
      return connected;
    },

    onConnection(cb) {
      cb(connected);
      return sub(connCbs, cb);
    },

    onState(cb) {
      const un = sub(stateCbs, cb);
      if (lastState) cb(lastState);
      return un;
    },

    async setState(state) {
      send({ t: "state", v: state });
    },

    claimHost() {
      wantHost = true;
      return new Promise<boolean>((resolve) => {
        hostWaiter = resolve;
        send({ t: "claimHost" });
        // 伺服器沒回就當沒搶到，不要讓投影幕卡在開機畫面
        setTimeout(() => {
          if (hostWaiter === resolve) {
            hostWaiter = null;
            resolve(false);
          }
        }, 3000);
      });
    },

    onPlayers(cb) {
      const un = sub(playerCbs, cb);
      cb(lastPlayers);
      return un;
    },

    async savePlayer(patch) {
      myPlayer = { ...myPlayer, ...patch };
      send({ t: "player", v: myPlayer });
    },

    onInputs(cb) {
      return sub(inputCbs, cb);
    },

    async sendInput(input) {
      send({ t: "input", v: input });
    },

    takeSeat() {
      return new Promise<number>((resolve, reject) => {
        seatWaiter = resolve;
        send({ t: "seat" });
        setTimeout(() => {
          if (seatWaiter === resolve) {
            seatWaiter = null;
            reject(new Error("伺服器沒有回座位號"));
          }
        }, 5000);
      });
    },

    async clearRoom() {
      send({ t: "clear" });
    },
  };
}
