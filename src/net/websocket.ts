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
  | { t: "pong" }
  | { t: "cmdAck"; k?: string; stages: number }
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
  /* uid 要分角色存。
     投影幕、主控台、手機是同一個網域下的三個頁面，localStorage 是共用的 ——
     共用一把 key 的話，在同一台電腦上開投影幕和主控台會變成：
     兩邊帶著同一個 uid 連上來，伺服器把 uid 當成「同一個人」，
     於是後到的踢掉先到的，先到的重連又踢掉後到的，無限互踢。
     現場的症狀就是「連線很不穩」「主控台按了沒反應」，而且只有
     把兩個頁面開在同一台機器上時才會發生。

     手機維持用舊的 key，這樣已經加入的人重整不會變成新的人（會重新分隊）。 */
  const UID_KEY = role === "play" ? "p100:uid" : `p100:uid:${role}`;

  // 開發時同一台電腦要開好幾個玩家，?u= 可以強制分身。
  const forced = new URLSearchParams(location.search).get("u");
  /* ============================================================
     心跳：手機這一端要能自己發現「線已經死了」

     最難處理的斷線不是「斷了」，是「看起來還連著」。
     手機從 Wi-Fi 切到行動網路、或是換一個基地台，TCP 連線會變成半開：
     readyState 還是 OPEN，onclose 不會觸發（在行動網路上可能拖好幾分鐘），
     畫面顯示「已連線」，但送出去的東西沒人收、伺服器送來的也進不來。

     主持人按下開始，全場動了、就是有幾個人不動 —— 那幾個人就是卡在這裡。
     他們自己不會知道，因為畫面看起來一切正常。

     WebSocket 協定層有 ping/pong，但那是瀏覽器自動回的，JavaScript 看不到，
     所以只能自己在應用層打一個。收不到回音就當作線死了，主動重連。

     3 秒打一次、10 秒沒回音就重連：這個組合在一場 30 分鐘的活動裡
     每支手機約 600 則訊息，對頻寬毫無影響，但把「卡住不動」的時間
     從幾分鐘壓到 10 秒以內。順帶還能讓 NAT 不要把閒置連線收掉。
     ============================================================ */
  const PING_MS = 3000;
  const PONG_TIMEOUT_MS = 10000;
  /** 連上但握手一直不完成也算掛了 —— 行動網路上這種卡住很常見。 */
  const OPEN_TIMEOUT_MS = 8000;

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
  /** 上一次確定「這條線還活著」的時刻。任何一則收到的訊息都算數。 */
  let lastPongAt = 0;

  const stateCbs: ((s: RoomState | null) => void)[] = [];
  const playerCbs: ((p: Record<string, Player>) => void)[] = [];
  const inputCbs: ((i: Record<string, Input>) => void)[] = [];
  const actionCbs: ((uid: string, a: PlayerAction) => void)[] = [];
  const commandCbs: ((c: Command) => void)[] = [];
  /**
   * 還沒有人訂閱時收到的指令。
   *
   * 伺服器在投影幕一連上就會把「上一場編好的地理題庫」用 cmd 送過來，
   * 但那時候 stage/main.ts 還在跑 openRoom 之後的初始化，onCommand 根本
   * 還沒註冊 —— 指令就這樣被丟掉，題目退回程式碼裡的預設值。
   *
   * state / players / scores 都是「訂閱時重播最後一筆」，指令沒有那個性質
   * （它是一次性的），所以改成先收著，第一個訂閱者出現時再一次倒給它。
   */
  let earlyCmds: Command[] = [];
  const scoreCbs: ((r: ScoreRow[]) => void)[] = [];
  const pinCbs: ((p: [number, number][]) => void)[] = [];
  const connCbs: ((ok: boolean) => void)[] = [];

  let lastState: RoomState | null = null;
  let lastPlayers: Record<string, Player> = {};
  let lastScores: ScoreRow[] = [];

  // 重連之後要補回去的東西
  let myPlayer: Partial<Player> | null = null;
  let wantHost = false;
  /**
   * 投影幕最後一次送出去的流程狀態。
   *
   * 投影幕的連線也會斷 —— 會場的 Wi-Fi 抖一下就夠了。斷著的那幾秒
   * 主持人按了開始，setState 靜默失敗，投影幕自己的畫面跑起來了，
   * 伺服器和一百支手機卻停在上一個狀態，而且不會有任何人發現。
   * 重連時補送一次，就不會有這種「只有投影幕知道遊戲開始了」的狀況。
   */
  let lastSentState: RoomState | null = null;

  const ackCbs: ((ack: { k?: string; stages: number }) => void)[] = [];

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
        lastPongAt = Date.now();
        fire(true);
        admitted?.resolve();
        admitted = null;
        // 重連時把身分補回去。順序很重要：先報到，再搶 host，
        // 最後才補狀態 —— 伺服器是照順序處理的，state 的權限檢查
        // 看的是 room.host，claimHost 沒先到就會被擋下來。
        if (myPlayer) send({ t: "player", v: myPlayer });
        if (wantHost) {
          send({ t: "claimHost" });
          if (lastSentState) send({ t: "state", v: lastSentState });
        }
        break;

      case "pong":
        lastPongAt = Date.now();
        break;

      case "cmdAck":
        for (const cb of ackCbs) cb({ k: msg.k, stages: msg.stages });
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
        if (commandCbs.length === 0) earlyCmds.push(msg.v);
        else for (const cb of commandCbs) cb(msg.v);
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

  /**
   * @returns 真的送出去了沒。
   *
   * 以前這裡是 void：連線斷掉就靜默丟掉。搖桿漏一格無所謂，
   * 但主控台按「下一關」被丟掉是會讓主持人在台上乾等的 ——
   * 而主控台是一支會不斷息屏、切 app 的手機，斷線是常態不是例外。
   * 現在把結果回報出去，讓呼叫端可以告訴使用者「沒送出去，再按一次」。
   */
  function send(msg: object): boolean {
    if (sock?.readyState !== WebSocket.OPEN) return false;
    sock.send(JSON.stringify(msg));
    return true;
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
        // 收到任何東西都代表線是活的，不必等 pong
        lastPongAt = Date.now();
        try {
          handle(JSON.parse(ev.data as string) as ServerMsg);
        } catch {
          /* 壞掉的訊息直接丟掉，下一則就好 */
        }
      };

      // 卡在 CONNECTING 的連線不會觸發 onclose，也不會觸發 onerror，
      // 就這樣掛著。沒有這個計時器的話，重連邏輯永遠不會再被叫醒。
      const openTimer = setTimeout(() => {
        if (s.readyState === WebSocket.CONNECTING) {
          try {
            s.close();
          } catch {
            /* 忽略 */
          }
        }
      }, OPEN_TIMEOUT_MS);

      s.onopen = () => {
        clearTimeout(openTimer);
        retry = 0;
        lastPongAt = Date.now();
        resolve();
      };

      s.onerror = () => {
        if (s.readyState !== WebSocket.OPEN) reject(new Error("WebSocket 連不上"));
      };

      s.onclose = () => {
        clearTimeout(openTimer);
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
  window.addEventListener("focus", wakeUp);

  /** 把現在這條線當作已死，立刻重連。 */
  function revive(why: string): void {
    if (closed || denied) return;
    console.warn("[p100] " + why + "，重連");
    retry = 0;
    const dead = sock;
    sock = null;
    if (dead) {
      dead.onclose = null; // 不要讓它再排一次重連，這裡自己來
      dead.onmessage = null;
      try {
        dead.close();
      } catch {
        /* 忽略 */
      }
    }
    fire(false);
    void connect().catch(() => {});
  }

  setInterval(() => {
    if (closed || denied) return;

    // 分頁被凍結的時候這個計時器也停著，回到前景第一次跑會看到一個
    // 很大的時間差 —— 那不是斷線，是剛醒過來。交給 wakeUp 處理就好。
    if (document.visibilityState !== "visible") {
      lastPongAt = Date.now();
      return;
    }

    if (sock?.readyState !== WebSocket.OPEN) {
      wakeUp();
      return;
    }

    if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
      revive("伺服器超過 " + PONG_TIMEOUT_MS / 1000 + " 秒沒有回音");
      return;
    }
    send({ t: "ping" });
  }, PING_MS);

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
      lastSentState = state;
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
      return send({ t: "cmd", v: cmd });
    },

    onCommandAck(cb) {
      return sub(ackCbs, cb);
    },

    onCommand(cb) {
      const un = sub(commandCbs, cb);
      if (earlyCmds.length > 0) {
        const queued = earlyCmds;
        earlyCmds = [];
        for (const c of queued) cb(c);
      }
      return un;
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
