/* ============================================================
   遊戲伺服器 —— 純中繼，不做物理運算

   投影幕（stage/render.ts）已經是權威端了，位置都在它的記憶體裡。
   伺服器只負責把訊息送到對的人手上：

     state    stage → 所有人
     input    play  → stage（攤平成 FLUSH_HZ 的批次）
     action   play  → stage（不攤平，每一筆都不能掉）
     command  console → stage（要先通過 Google 身分驗證）
     scores   stage → console（不廣播給手機）

   非對稱扇出是整個架構的命脈：input 和 players 只送給 stage。
   轉給所有人的話是 O(n²)：120 人 × 20 Hz × 120 個收件者 = 每秒 29 萬則。

   刻意不用 TypeScript、不用 build step：這支檔案要讓社團任何人
   `node server/index.js` 就跑得起來，出事的時候看得懂。
   ============================================================ */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { OAuth2Client } from "google-auth-library";

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

/* ============================================================
   主控台的身分驗證

   前端自己檢查 email 是裝飾品 —— 打開 devtools 就繞過了。
   真正的防線只能在這裡：驗 Google 簽發的 ID token 的簽章、
   驗 audience 是不是我們的 client id、再比對 email。

   兩個環境變數都沒設的話，主控台會開放給任何人（方便本機開發），
   啟動時會印一行明顯的警告。正式環境一定要設。
   ============================================================ */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const oauth = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const authEnabled = Boolean(oauth && ALLOWED_EMAILS.length > 0);

/** @returns 通過的話回 email，不通過回 null */
async function verifyConsole(idToken) {
  if (!authEnabled) return "dev@localhost";
  if (!idToken) return null;
  try {
    const ticket = await oauth.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = (payload?.email ?? "").toLowerCase();
    // email_verified 一定要看：沒驗證過的 email 是可以偽造的
    if (!payload?.email_verified || !ALLOWED_EMAILS.includes(email)) return null;
    return email;
  } catch (e) {
    console.warn("[auth] token 驗不過：", e?.message ?? e);
    return null;
  }
}

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
    /* 最後一張計分表。主控台中途連進來要馬上看得到。 */
    this.scores = [];

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

  /** 送給某一種角色。inputs/players/scores 靠這個維持非對稱扇出。 */
  toRole(role, msg) {
    const raw = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.role === role && c.sock.readyState === 1) c.sock.send(raw);
    }
  }

  flushInputs() {
    const batch = this.pendingInputs;
    if (Object.keys(batch).length === 0) return;
    this.pendingInputs = {};
    this.toRole("stage", { t: "inputs", v: batch });
  }

  flushRoster() {
    if (!this.rosterDirty) return;
    this.rosterDirty = false;
    this.toRole("stage", { t: "players", v: this.players });
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
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, auth: authEnabled }));
    return;
  }
  /* 現場用手機打開這個網址就能確認伺服器活著，不用開終端機 */
  const total = [...rooms.values()].reduce((n, r) => n + r.clients.size, 0);
  const lines = [...rooms.values()].map(
    (r) => "  " + r.code + ": " + r.clients.size + " 人, host=" + (r.host ? "有" : "無"),
  );
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(
    "遊戲伺服器運作中\n房間 " + rooms.size + " 個｜連線 " + total + " 人\n" +
      "主控台驗證：" + (authEnabled ? "開啟" : "關閉（開發模式）") + "\n" +
      lines.join("\n"),
  );
});

const wss = new WebSocketServer({ server });

wss.on("connection", (sock, req) => {
  const url = new URL(req.url ?? "/", "http://x");
  /* 房號已經從前端拿掉了，一律走同一個房間。
     這裡還留著是給壓力測試隔離用的，一般使用者碰不到。 */
  const code = (url.searchParams.get("r") ?? "MAIN").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const raw = url.searchParams.get("role");
  const role = raw === "stage" || raw === "console" ? raw : "play";
  /* 手機重整不要變成新的人（會重新分隊）。帶不帶都可以，帶了就沿用。 */
  const wanted = url.searchParams.get("uid");

  const room = roomFor(code);
  const uid = wanted && !room.clients.has(wanted) ? wanted : randomUUID();

  const client = { sock, uid, role, email: null };

  sock.isAlive = true;
  sock.on("pong", () => {
    sock.isAlive = true;
  });

  /* 主控台要先驗過才收進房間，驗不過直接關掉。 */
  const admit = async () => {
    if (role === "console") {
      const email = await verifyConsole(url.searchParams.get("token"));
      if (!email) {
        sock.send(JSON.stringify({ t: "denied", why: "這個帳號沒有主控台權限" }));
        sock.close(4003, "forbidden");
        return false;
      }
      client.email = email;
    }
    room.clients.set(uid, client);
    return true;
  };

  void admit().then((ok) => {
    if (!ok) return;

    room.send(client, { t: "welcome", uid, room: code, email: client.email });
    if (room.state) room.send(client, { t: "state", v: room.state });
    if (role === "stage") {
      /* 投影幕重新整理（或備用筆電接手）要馬上拿到完整名單 */
      room.send(client, { t: "players", v: room.players });
      /* 分數只活在投影幕的記憶體裡，重整就沒了。伺服器留著最後一張
         計分表，接手的那台可以把總分接回去 —— 不然備用筆電救得了畫面，
         救不了分數。只在連線時送這一次，不會跟 stage 自己送上來的互相回聲。 */
      if (room.scores.length) room.send(client, { t: "scores", v: room.scores });
    }
    if (role === "console") {
      room.send(client, { t: "scores", v: room.scores });
    }

    sock.on("message", (data) => {
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (m.t) {
        case "claimHost": {
          const ok2 = room.host === null || room.host === uid;
          if (ok2) room.host = uid;
          room.send(client, { t: "host", ok: ok2 });
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

        case "action": {
          /* 一次性事件，不攤平也不等節流 —— 掉了就是那個人這題沒分 */
          room.toRole("stage", { t: "action", uid, v: m.v });
          break;
        }

        case "cmd": {
          /* 這是整個驗證機制的意義所在：只有驗過的主控台能下指令。
             role 是連線時就釘死的，中途改不了。 */
          if (client.role !== "console") return;
          room.toRole("stage", { t: "cmd", v: m.v });
          break;
        }

        case "scores": {
          if (room.host !== uid) return;
          room.scores = m.v ?? [];
          room.toRole("console", { t: "scores", v: room.scores });
          break;
        }

        case "clear": {
          if (room.host !== uid) return;
          room.players = {};
          room.pendingInputs = {};
          room.state = null;
          room.scores = [];
          room.seat = 0;
          room.toRole("stage", { t: "players", v: {} });
          room.broadcast({ t: "state", v: null });
          break;
        }
      }
    });
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
  if (authEnabled) {
    console.log("主控台限定：" + ALLOWED_EMAILS.join(", "));
  } else {
    console.warn(
      "⚠️  主控台沒有身分驗證，任何人都能控制投影幕。\n" +
        "    正式環境請設 GOOGLE_CLIENT_ID 與 ALLOWED_EMAILS（見 docs/SETUP.md）。",
    );
  }
});
