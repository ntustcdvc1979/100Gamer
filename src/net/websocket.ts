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

import type {
  Command,
  Input,
  Player,
  PlayerAction,
  RoomState,
  ScoreRow,
} from "./schema";
import type { Role, RoomTransport, Unsubscribe } from "./transport";

type ServerMsg =
  | { t: "welcome"; uid: string; email: string | null }
  | { t: "denied"; why: string }
  | { t: "state"; v: RoomState | null }
  | { t: "players"; v: Record<string, Player> }
  | { t: "inputs"; v: Record<string, Input> }
  | { t: "action"; uid: string; v: PlayerAction }
  | { t: "cmd"; v: Command }
  | { t: "scores"; v: ScoreRow[] }
  | { t: "pins"; v: [number, number][] }
  | { t: "host"; ok: boolean };

/** 主控台驗不過的時候丟這個，呼叫端才能顯示「這個帳號沒有權限」。 */
export class AccessDenied extends Error {}

export async function createWebsocketTransport(
  baseUrl: string,
  role: Role,
  token?: string,
): Promise<RoomTransport> {
  const UID_KEY = "p100:uid";

  // 開發時同一台電腦要開好幾個玩家，?u= 可以強制分身。
  const forced = new URLSearchParams(location.search).get("u");
  let uid = "";
  try {
    const stored = localStorage.getItem(UID_KEY) ?? "";
    uid = forced ? `${stored}-${forced}` : stored;
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
  const actionCbs: ((uid: string, a: PlayerAction) => void)[] = [];
  const commandCbs: ((c: Command) => void)[] = [];
  const scoreCbs: ((r: ScoreRow[]) => void)[] = [];
  const pinCbs: ((p: [number, number][]) => void)[] = [];
  const connCbs: ((ok: boolean) => void)[] = [];

  let lastState: RoomState | null = null;
  let lastPlayers: Record<string, Player> = {};
  let lastScores: ScoreRow[] = [];

  // 重連之後要補回去的東西
  let myPlayer: Partial<Player> | null = null;
  let wantHost = false;

  let hostWaiter: ((ok: boolean) => void) | null = null;

  function url(): string {
    const u = new URL(baseUrl);
    u.searchParams.set("role", role);
    if (uid) u.searchParams.set("uid", uid);
    if (token) u.searchParams.set("token", token);
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

  let denied: string | null = null;
  /**
   * 伺服器真的回過 welcome 了沒。
   *
   * 不能拿 uid 判斷 —— uid 是開場就從 localStorage 撈出來的，
   * 一開始就是有值的。拿它當「已放行」會讓主控台完全跳過驗證。
   */
  let welcomed = false;
  /** 主控台在等伺服器放行 */
  let admitted: { resolve: () => void; reject: (e: Error) => void } | null = null;

  function handle(msg: ServerMsg): void {
    switch (msg.t) {
      case "welcome":
        uid = msg.uid;
        try {
          if (!forced) localStorage.setItem(UID_KEY, uid);
        } catch {
          /* 忽略 */
        }
        welcomed = true;
        fire(true);
        admitted?.resolve();
        admitted = null;
        // 重連時把身分補回去。順序很重要：先報到，再搶 host。
        if (myPlayer) send({ t: "player", v: myPlayer });
        if (wantHost) send({ t: "claimHost" });
        break;

      case "denied":
        denied = msg.why;
        closed = true; // 不要重連，重連一樣會被拒絕
        admitted?.reject(new AccessDenied(msg.why));
        admitted = null;
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
        // 伺服器已經攤平成批次，這裡拿到的是「這一輪動過的人」
        for (const cb of inputCbs) cb(msg.v ?? {});
        break;

      case "action":
        for (const cb of actionCbs) cb(msg.uid, msg.v);
        break;

      case "cmd":
        for (const cb of commandCbs) cb(msg.v);
        break;

      case "scores":
        lastScores = msg.v ?? [];
        for (const cb of scoreCbs) cb(lastScores);
        break;

      case "pins":
        // 伺服器已經按隊分流過，這裡收到的就是自己這一隊的座標
        for (const cb of pinCbs) cb(msg.v ?? []);
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
      // 先把上一條連線徹底切乾淨。
      //
      // 不做這件事的話會疊出多條 socket：舊的那條之後還是會觸發 onclose，
      // 又排一次重連，於是一支手機在伺服器上變成好幾條連線，
      // uid 接手互相打架。把 handler 清掉再關，它就不會再叫醒任何人。
      if (sock) {
        const old = sock;
        old.onopen = null;
        old.onmessage = null;
        old.onerror = null;
        old.onclose = null;
        if (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING) {
          try {
            old.close();
          } catch {
            /* 已經關了就算了 */
          }
        }
      }

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
        if (denied) {
          reject(new AccessDenied(denied));
          return;
        }
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

  /* ============================================================
     回到前景就立刻重連，不要等退避。

     手機息屏、切到別的 app、鎖起來放口袋 —— 這些都會讓連線斷掉，
     而且瀏覽器會把整個分頁凍結，退避計時器也停著。等使用者解鎖回來，
     他會先看到「連線中斷」，然後還要再等最多 5 秒。

     實際上「螢幕亮起來」就是最好的重連信號：使用者正在看，網路也回來了。
     online 事件同理（切換 Wi-Fi／行動網路）。
     ============================================================ */
  function wakeUp(): void {
    if (closed || denied) return;
    if (sock?.readyState === WebSocket.OPEN || sock?.readyState === WebSocket.CONNECTING) return;
    retry = 0;
    void connect().catch(() => {});
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wakeUp();
  });
  window.addEventListener("online", wakeUp);
  window.addEventListener("pageshow", wakeUp);

  // 主控台要等伺服器明確放行才算連上。
  //
  // 不能用「等 150ms 看有沒有被拒」來判斷：伺服器第一次驗 Google token
  // 要去抓 JWKS，動輒幾百毫秒。等太短會誤判成通過，然後停在一個
  // 已經被關掉的連線上，畫面看起來正常但什麼都按不動。
  if (role === "console") {
    await new Promise<void>((resolve, reject) => {
      if (denied) return reject(new AccessDenied(denied));
      if (welcomed) return resolve();
      admitted = { resolve, reject };
      setTimeout(() => {
        if (admitted) {
          admitted = null;
          reject(new Error("伺服器沒有回應主控台的登入"));
        }
      }, 15000);
    });
  }

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

    async sendAction(action) {
      send({ t: "action", v: action });
    },

    onActions(cb) {
      return sub(actionCbs, cb);
    },

    sendCommand(cmd) {
      send({ t: "cmd", v: cmd });
    },

    onCommand(cb) {
      return sub(commandCbs, cb);
    },

    publishScores(rows) {
      send({ t: "scores", v: rows });
    },

    publishPins(pins) {
      send({ t: "pins", v: pins });
    },

    onPins(cb) {
      return sub(pinCbs, cb);
    },

    onScores(cb) {
      const un = sub(scoreCbs, cb);
      if (lastScores.length) cb(lastScores);
      return un;
    },

    async clearRoom() {
      send({ t: "clear" });
    },
  };
}
