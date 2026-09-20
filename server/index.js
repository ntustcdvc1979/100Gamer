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

/* 房間空了之後還留多久才真的丟掉。

   原本是「一個人都沒有就立刻刪」，那會毀掉整個接手機制：
   投影幕重整的那一兩秒，如果剛好主控台也關著、手機還沒進來，
   房間就被刪了 —— 連同分數和主持人編好的地理題庫。
   而那正是接手要處理的情境本身。

   十分鐘夠涵蓋任何一次重整、換筆電、或中場休息。 */
const ROOM_TTL_MS = 10 * 60 * 1000;

/* ============================================================
   主控台的身分驗證

   前端自己檢查 email 是裝飾品 —— 打開 devtools 就繞過了。
   真正的防線只能在這裡：驗 Google 簽發的 ID token 的簽章、
   驗 audience 是不是我們的 client id、再比對 email。

   兩個環境變數都沒設的話，主控台會開放給任何人（方便本機開發），
   啟動時會印一行明顯的警告。正式環境一定要設。
   ============================================================ */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";

/**
 * 把 email 正規化再比對。
 *
 * 三個現場一定會踩到的地雷：
 *
 *   1. 引號跑進值裡。`fly secrets set ALLOWED_EMAILS="a@gmail.com"` 在某些
 *      shell 下會連引號一起存進去，比對就永遠不會中。
 *   2. Gmail 忽略點。a.b@gmail.com 和 ab@gmail.com 是**同一個 Google 帳號**，
 *      但字串不一樣。名單裡打了點、登入的帳號沒點（或反過來）就對不上。
 *   3. Gmail 的 +標籤。a+party@gmail.com 也是同一個帳號。
 *
 * 只對 gmail / googlemail 做點與 +標籤的處理 —— 其他網域的點是有意義的，
 * 亂拿掉會把不同的人當成同一個。
 */
function canonicalEmail(raw) {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  const at = cleaned.lastIndexOf("@");
  if (at < 0) return cleaned;
  let local = cleaned.slice(0, at);
  const domain = cleaned.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.split("+")[0].replace(/\./g, "");
    return `${local}@gmail.com`;
  }
  return `${local}@${domain}`;
}

const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS ?? "")
  .split(",")
  .map(canonicalEmail)
  .filter(Boolean);

const oauth = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const authEnabled = Boolean(oauth && ALLOWED_EMAILS.length > 0);

/**
 * @returns { ok: true, email } 或 { ok: false, why }
 *
 * why 要分得出「根本沒帶 token」和「帳號不在名單」——
 * 前者代表那個網站沒設 VITE_GOOGLE_CLIENT_ID（登入按鈕根本沒出現），
 * 後者才是真的權限問題。兩種的處理方式完全不同，
 * 混在一起的話現場會對著「你沒有權限」找不到登入按鈕。
 */
async function verifyConsole(idToken) {
  if (!authEnabled) return { ok: true, email: "dev@localhost" };
  if (!idToken) {
    return {
      ok: false,
      why: "這個網站沒有帶 Google 登入資訊（前端少了 VITE_GOOGLE_CLIENT_ID）",
    };
  }
  try {
    const ticket = await oauth.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const shown = (payload?.email ?? "").toLowerCase();
    const email = canonicalEmail(shown);
    // email_verified 一定要看：沒驗證過的 email 是可以偽造的
    if (!payload?.email_verified) return { ok: false, why: "這個 Google 帳號的信箱沒有驗證過" };
    if (!ALLOWED_EMAILS.includes(email)) {
      // 兩邊都印出來。只印被拒的那一個，管理員還是不知道名單裡到底是什麼，
      // 只能一直猜。這一行在 `fly logs` 看得到。
      console.warn(`[auth] 拒絕 ${shown}（正規化後 ${email}）｜名單：${ALLOWED_EMAILS.join(", ")}`);
      return {
        ok: false,
        why:
          `${shown} 不在主控台的白名單裡。` +
          `請用這個帳號重設：fly secrets set ALLOWED_EMAILS="${shown}"`,
      };
    }
    return { ok: true, email: shown };
  } catch (e) {
    console.warn("[auth] token 驗不過：", e?.message ?? e);
    return { ok: false, why: "Google 登入憑證驗不過（client id 可能對不上）" };
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
    /* 被主控台踢掉的人。
       只擋 uid —— 清掉瀏覽器資料就能再進來，但那不是這個功能要防的事。
       它要防的是「有人一直亂玩，踢掉之後不要三秒又自己回來」。 */
    this.banned = new Set();
    /* 最後一張計分表。主控台中途連進來要馬上看得到。 */
    this.scores = [];
    /* 主控台改過的地理題庫與照片。
       投影幕重開（或備用筆電接手）時要把這些補回去 ——
       不然主持人辛苦編好的題目會整個退回程式碼裡的預設值。
       跟分數一樣的道理：伺服器是唯一活過客戶端重整的地方。 */
    this.geoList = null;
    this.geoPhotos = new Map();
    this.ttlTimer = null;

    this.flushTimer = setInterval(() => this.flushInputs(), 1000 / FLUSH_HZ);
    this.rosterTimer = setInterval(() => this.flushRoster(), 1000 / ROSTER_HZ);
  }

  get empty() {
    return this.clients.size === 0;
  }

  close() {
    clearInterval(this.flushTimer);
    clearInterval(this.rosterTimer);
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
  }

  /** 空了就排一個延後刪除，有人回來就取消。 */
  scheduleCleanup(remove) {
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    this.ttlTimer = setTimeout(() => {
      if (!this.empty) return;
      console.log("[room] " + this.code + " 閒置逾時，清掉");
      this.close();
      remove();
    }, ROOM_TTL_MS);
  }

  /** 有人連進來就把延後刪除取消掉。 */
  keepAlive() {
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
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

  /**
   * @param sock 只有在「這個 uid 現在登記的就是這條連線」時才移除。
   *
   * 接手（takeover）的時候，舊 socket 的 close 事件會比新連線註冊
   * 晚一拍才觸發。不比對的話，那一拍會把剛接手的新連線從名單上刪掉 ——
   * 玩家會看到自己一連上就馬上從投影幕消失。
   */
  drop(uid, sock) {
    const c = this.clients.get(uid);
    if (!c) return;
    if (sock && c.sock !== sock) return;
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
  r.keepAlive();
  return r;
}

const server = createServer((req, res) => {
  if (req.url === "/health") {
    // 前端在別的網域（GitHub Pages），要能問到「這台有沒有開驗證」。
    // 只吐 {ok, rooms, auth} 三個欄位，開放讀沒有風險。
    res.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
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

  /* uid 是「一個人」，不是「一條連線」。
     有人帶著已經在線上的 uid 連進來，代表他的舊連線其實已經死了
     （換基地台、Wi-Fi 切 4G、進電梯），只是伺服器還沒察覺。

     舊的寫法是「被佔用就發一個新 uid」，那會很慘：
     名單上同一個人變成兩筆，舊的那筆超時被清掉時連帶把分數清掉；
     而手機的 localStorage 還記著舊 uid，下次重連又翻回去。

     正確的做法是接手：把舊連線關掉，新的沿用同一個 uid。 */
  const uid = wanted || randomUUID();
  const stale = wanted ? room.clients.get(wanted) : undefined;
  if (stale && stale.sock !== sock) {
    console.log("[takeover] " + uid);
    try {
      stale.sock.terminate();
    } catch {
      /* 已經死了就算了 */
    }
    room.clients.delete(uid);
  }

  if (role === "play" && room.banned.has(uid)) {
    sock.send(JSON.stringify({ t: "denied", why: "你已經被主持人請出遊戲" }));
    sock.close(4003, "banned");
    return;
  }

  const client = { sock, uid, role, email: null };

  sock.missed = 0;
  sock.on("pong", () => {
    sock.missed = 0;
  });

  /* 主控台要先驗過才收進房間，驗不過直接關掉。 */
  const admit = async () => {
    if (role === "console") {
      const verdict = await verifyConsole(url.searchParams.get("token"));
      if (!verdict.ok) {
        sock.send(JSON.stringify({ t: "denied", why: verdict.why }));
        sock.close(4003, "forbidden");
        return false;
      }
      client.email = verdict.email;
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
      /* 地理題庫與照片同理 —— 主持人編好的東西不該因為投影幕重整就沒了。
         先送題庫再送照片：setGeoList 會把照片清掉，順序反了就白送。 */
      if (room.geoList) {
        room.send(client, { t: "cmd", v: { k: "geoList", list: room.geoList } });
        for (const [index, dataUri] of room.geoPhotos) {
          room.send(client, { t: "cmd", v: { k: "geoPhoto", index, dataUri } });
        }
      }
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

          /* 踢人是伺服器的事，不是投影幕的 ——
             投影幕只能不畫他，斷不了他的連線。 */
          if (m.v?.k === "kick" && typeof m.v.uid === "string") {
            const victim = room.clients.get(m.v.uid);
            room.banned.add(m.v.uid);
            if (victim) {
              victim.sock.send(JSON.stringify({ t: "denied", why: "你已經被主持人請出遊戲" }));
              victim.sock.close(4003, "kicked");
            }
            room.drop(m.v.uid);
            console.log("[kick] " + m.v.uid);
            return;
          }

          /* 記住題庫與照片，投影幕重開時要補回去。
             伺服器只是存著轉發，不解讀內容。 */
          if (m.v?.k === "geoList") {
            room.geoList = m.v.list ?? [];
            room.geoPhotos.clear();
          } else if (m.v?.k === "geoPhoto" && typeof m.v.index === "number") {
            if (m.v.dataUri) room.geoPhotos.set(m.v.index, m.v.dataUri);
            else room.geoPhotos.delete(m.v.index);
          }

          room.toRole("stage", { t: "cmd", v: m.v });
          break;
        }

        case "scores": {
          if (room.host !== uid) return;
          room.scores = m.v ?? [];
          room.toRole("console", { t: "scores", v: room.scores });
          break;
        }

        case "pins": {
          /* 地理達人：每支手機只收自己那一隊的座標。
             這是伺服器唯一做「內容分流」的地方 —— 它之所以做得到，
             是因為 players 裡有每個人的隊伍。整包廣播出去的話，
             每支手機都會收到全場一百個座標，那正是規則一在防的扇出。 */
          if (room.host !== uid) return;
          const byTeam = m.v ?? {};
          for (const c of room.clients.values()) {
            if (c.role !== "play" || c.sock.readyState !== 1) continue;
            const team = room.players[c.uid]?.team;
            c.sock.send(JSON.stringify({ t: "pins", v: (team && byTeam[team]) || [] }));
          }
          break;
        }

        case "clear": {
          if (room.host !== uid) return;
          room.players = {};
          room.pendingInputs = {};
          room.state = null;
          room.scores = [];
          room.banned.clear();
          room.geoList = null;
          room.geoPhotos.clear();
              room.toRole("stage", { t: "players", v: {} });
          room.broadcast({ t: "state", v: null });
          break;
        }
      }
    });
  });

  sock.on("close", () => {
    room.drop(uid, sock);
    if (room.empty) room.scheduleCleanup(() => rooms.delete(code));
  });

  sock.on("error", () => sock.terminate());
});

/* 手機鎖屏、走進電梯不會送 close，只能靠心跳把它清掉，
   不然投影幕上會留著一堆早就離開的人。

   但只容許漏一次 pong 太嚴格了：手機息屏或切到別的 app 的時候，
   整個分頁會被凍結，30 秒漏一拍是家常便飯 —— 那樣會把只是暫時
   把手機收起來的人全部踢掉。容許連漏兩次（約 60–90 秒）才砍。 */
const MISSES_ALLOWED = 2;

const heartbeat = setInterval(() => {
  for (const sock of wss.clients) {
    sock.missed = (sock.missed ?? 0) + 1;
    if (sock.missed > MISSES_ALLOWED) {
      sock.terminate();
      continue;
    }
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
