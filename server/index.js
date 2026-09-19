/* ============================================================
   遊戲伺服器 —— 純中繼，不做物理運算

   投影幕（stage/render.ts）已經是權威端了，位置都在它的記憶體裡。
   所以這支伺服器只做四件事：

     1. 發座位號（原子遞增，隊伍人數保證平均）
     2. 守 host（第一個 stage 佔位，之後只有它改得動 state）
     3. 把 state 廣播給所有人
     4. 把 input「只轉給 stage」—— 不是廣播給所有人

   第 4 點是整個架構的命脈。轉給所有人就是 O(n²) 扇出：
   120 人 × 20 Hz × 120 個收件者 = 每秒 29 萬則，必死。

   刻意不用 TypeScript、不用 build step：這支檔案要讓社團任何人
   `node server/index.js` 就跑得起來，出事的時候看得懂。
   ============================================================ */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8080);

/* 輸入轉給投影幕的頻率。這是伺服器最重要的一個節流：
   120 人 × 20 Hz 進來是每秒 2400 則，攤平之後出去只有 FLUSH_HZ 則。

   為什麼是 60 而不是 20：攤平的間隔會整個加到延遲上。
   設 20 Hz 時本機實測 p50 就有 64ms（送出和攤平同為 50ms 週期會相位鎖死，
   每則幾乎都要等滿一輪），那在東京再加 30–50ms 的來回就沒有意義了。
   60 Hz 讓這段降到約 8ms，而且剛好等於投影幕的畫面更新率 ——
   送得比投影幕畫得還快沒有任何好處。攤平的效益還是有 40 倍。 */
const FLUSH_HZ = Number(process.env.FLUSH_HZ ?? 60);

/* 名單變動的廣播頻率。開場前 100 人同時掃 QR，不節流的話會洗版。 */
const ROSTER_HZ = Number(process.env.ROSTER_HZ ?? 4);

/* 多久沒有 pong 就當對方斷了。手機鎖屏、走進電梯都會觸發。 */
const HEARTBEAT_MS = 30000;

const rooms = new Map();

class Room {
  constructor(code) {
    this.code = code;
    this.clients = new Map();
    this.host = null;
    this.state = null;
    this.players = {};
    /* 累積待轉給 stage 的輸入，攤平之後一次送 */
    this.pendingInputs = {};
    this.rosterDirty = false;
    this.seat = 0;

    this.flushTimer = setInterval(() => this.flushInputs(), 1000 / FLUSH_HZ);
    this.rosterTimer = setInterval(() => this.flushRoster(), 1000 / ROSTER_HZ);
  }

  get empty() {
    return this.clients.size === 0;
  }

  close() {
    clearInterval(this.flushTimer);
    clearInterval(this.rosterTimer);
  }

  send(client, msg) {
    if (client.sock.readyState === 1) {
      client.sock.send(JSON.stringify(msg));
    }
  }

  /* 送給所有人。只有 state 會走這條。 */
  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.sock.readyState === 1) c.sock.send(raw);
    }
  }

  /* 送給投影幕。inputs 和 players 只走這條 —— 這是非對稱扇出的實作。 */
  toStages(msg) {
    const raw = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.role === "stage" && c.sock.readyState === 1) c.sock.send(raw);
    }
  }

  flushInputs() {
    const batch = this.pendingInputs;
    if (Object.keys(batch).length === 0) return;
    this.pendingInputs = {};
    this.toStages({ t: "inputs", v: batch });
  }

  flushRoster() {
    if (!this.rosterDirty) return;
    this.rosterDirty = false;
    this.toStages({ t: "players", v: this.players });
  }

  drop(uid) {
    const c = this.clients.get(uid);
    if (!c) return;
    this.clients.delete(uid);
    /* 投影幕掛了就把 host 讓出來，備用筆電才接得了手 */
    if (this.host === uid) this.host = null;
    if (this.players[uid]) {
      delete this.players[uid];
      delete this.pendingInputs[uid];
      this.rosterDirty = true;
      /* 離場要馬上看得到，不用等節流 */
      this.flushRoster();
    }
  }
}

function roomFor(code) {
  let r = rooms.get(code);
  if (!r) {
    r = new Room(code);
    rooms.set(code, r);
  }
  return r;
}

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  /* 現場用手機打開這個網址就能確認伺服器活著，不用開終端機 */
  const total = [...rooms.values()].reduce((n, r) => n + r.clients.size, 0);
  const lines = [...rooms.values()].map(
    (r) => "  " + r.code + ": " + r.clients.size + " 人, host=" + (r.host ? "有" : "無"),
  );
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("遊戲伺服器運作中\n房間 " + rooms.size + " 個｜連線 " + total + " 人\n" + lines.join("\n"));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (sock, req) => {
  const url = new URL(req.url ?? "/", "http://x");
  const code = (url.searchParams.get("r") ?? "PARTY").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const role = url.searchParams.get("role") === "stage" ? "stage" : "play";
  /* 手機重整不要變成新的人（會重新分隊）。帶不帶都可以，帶了就沿用。 */
  const wanted = url.searchParams.get("uid");

  const room = roomFor(code);
  const uid = wanted && !room.clients.has(wanted) ? wanted : randomUUID();

  const client = { sock, uid, role };
  room.clients.set(uid, client);

  sock.isAlive = true;
  sock.on("pong", () => {
    sock.isAlive = true;
  });

  room.send(client, { t: "welcome", uid, room: code });
  if (room.state) room.send(client, { t: "state", v: room.state });
  if (role === "stage") {
    /* 投影幕重新整理（或備用筆電接手）要馬上拿到完整名單 */
    room.send(client, { t: "players", v: room.players });
  }

  sock.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (m.t) {
      case "claimHost": {
        const ok = room.host === null || room.host === uid;
        if (ok) room.host = uid;
        room.send(client, { t: "host", ok });
        break;
      }

      case "seat": {
        room.send(client, { t: "seat", n: room.seat++ });
        break;
      }

      case "state": {
        /* 只有 host 改得動流程。少了這一行，任何人都能拿手機把關卡跳掉。 */
        if (room.host !== uid) return;
        room.state = m.v;
        room.broadcast({ t: "state", v: m.v });
        break;
      }

      case "player": {
        room.players[uid] = Object.assign({}, room.players[uid], m.v);
        room.rosterDirty = true;
        break;
      }

      case "input": {
        /* 攤平：同一輪內同一個人只留最新的一筆 */
        room.pendingInputs[uid] = m.v;
        break;
      }

      case "clear": {
        if (room.host !== uid) return;
        room.players = {};
        room.pendingInputs = {};
        room.state = null;
        room.seat = 0;
        room.toStages({ t: "players", v: {} });
        room.broadcast({ t: "state", v: null });
        break;
      }
    }
  });

  sock.on("close", () => {
    room.drop(uid);
    if (room.empty) {
      room.close();
      rooms.delete(code);
    }
  });

  sock.on("error", () => sock.terminate());
});

/* 手機鎖屏、走進電梯不會送 close，只能靠心跳把它清掉，
   不然投影幕上會留著一堆早就離開的人。 */
const heartbeat = setInterval(() => {
  for (const sock of wss.clients) {
    if (sock.isAlive === false) {
      sock.terminate();
      continue;
    }
    sock.isAlive = false;
    sock.ping();
  }
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log("遊戲伺服器聽在 :" + PORT + "｜輸入轉發 " + FLUSH_HZ + " Hz｜名單 " + ROSTER_HZ + " Hz");
});
