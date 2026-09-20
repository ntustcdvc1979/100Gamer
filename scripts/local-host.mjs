/* ============================================================
   現場自架：把網站和遊戲伺服器一起跑在投影幕那台電腦上

   平常的跑法是「網站在 GitHub Pages、伺服器在 Fly.io 東京」，玩家走行動網路。
   這支是另一條路：整套都在筆電上，玩家連筆電所在的 Wi-Fi。

   為什麼不能只把伺服器搬到筆電、網站還留在 GitHub Pages：
   GitHub Pages 是 HTTPS，瀏覽器會擋掉 HTTPS 頁面連 ws:// 的區網位址
   （mixed content），而區網 IP 拿不到憑證，所以也沒辦法改用 wss://。
   結論是網站必須跟伺服器一起用 http 從同一台機器發出去 —— 同源就沒有這個問題。

   ⚠️ 這條路換掉的是網路假設，不只是換一個網址

     好處  延遲 1–5ms（Fly 東京是 60ms），不靠外網，場地對外斷線也能玩
     代價  全場必須連同一個 Wi-Fi。消費級 AP 常常撐不住 100 台同時連，
           而當初選行動網路正是為了避開這件事。

   所以這不是預設路徑，是「場地網路夠強」或「完全沒有外網」時的選項。
   決定用它之前，務必在現場實測 100 支手機同時連上那個 AP。

   怎麼跑（兩行）：
     VITE_WS_URL=auto npm run build
     npm run host

   為什麼 build 要帶 VITE_WS_URL=auto：那個值的意思是「連回這一頁的同一個來源」。
   現場自架時網址是筆電的區網 IP，build 的當下不會知道，寫死就得每換一個
   場地重 build 一次。詳見 src/net/wsurl.ts。
   ============================================================ */

import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const PORT = Number(process.env.HOST_PORT ?? 8080);
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const SERVER_JS = fileURLToPath(new URL("../server/index.js", import.meta.url));

/* 遊戲伺服器不能跟網站搶同一個 port，所以它躲在 PORT+1，
   由下面的 proxy 把 WebSocket 和 /health 轉過去。
   這樣對外只有一個 port，前端才能用「同源」推算伺服器位址。 */
const GAME_PORT = PORT + 1;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

/** 區網 IP。手機要連的是這個，不是 localhost。 */
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

const ip = lanAddress();
const base = `http://${ip}:${PORT}`;

/* 遊戲伺服器開在另一個 process，這樣它掛掉不會把網站一起帶走 ——
   現場最怕的是「什麼都連不上」，至少要讓人還看得到頁面。 */
const game = spawn(process.execPath, [SERVER_JS], {
  env: { ...process.env, PORT: String(GAME_PORT) },
  stdio: "inherit",
});
game.on("exit", (code) => {
  console.error(`[host] ⚠️ 遊戲伺服器結束了（code ${code}）。網站還活著，但沒人連得上遊戲。`);
});

/* 用 localhost 開投影幕的話，QR 會編出 http://localhost:8080/play.html ——
   手機掃了只會連到自己。與其在畫面上警告，不如直接把人導到區網 IP，
   這樣不管操作的人打了什麼，QR 都是對的。 */
function wrongHost(req) {
  if (ip === "localhost") return null; // 找不到區網 IP，導了只會變成無窮迴圈
  const host = (req.headers.host ?? "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1") return null;
  return base + (req.url ?? "/");
}

const server = createServer(async (req, res) => {
  const fixed = wrongHost(req);
  if (fixed) {
    res.writeHead(302, { location: fixed });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", base);

  // 主控台會打 /health 問「伺服器有沒有開驗證」，轉給遊戲伺服器回答
  if (url.pathname === "/health") {
    const up = httpRequest(
      { host: "127.0.0.1", port: GAME_PORT, path: "/health", method: "GET" },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => res.writeHead(502).end("{}"));
    up.end();
    return;
  }

  let path = decodeURIComponent(url.pathname);
  if (path === "/") path = "/index.html";

  // 擋住 ../ 之類的路徑穿越
  const file = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      // 現場常常要改完馬上重 build，快取只會害人看到舊版
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("找不到這個檔案。是不是忘了先跑 VITE_WS_URL=auto npm run build？");
  }
});

/* WebSocket 轉送：把 upgrade 之後的 TCP 直接對接，不解析內容。
   ws 函式庫的握手、ping/pong、關閉碼都原樣通過。 */
server.on("upgrade", (req, socket, head) => {
  const up = connect(GAME_PORT, "127.0.0.1", () => {
    up.write(
      `GET ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`)
          .join("") +
        "\r\n",
    );
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const bail = () => {
    up.destroy();
    socket.destroy();
  };
  up.on("error", bail);
  socket.on("error", bail);
});

server.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log("  現場自架模式");
  console.log("=".repeat(60));
  console.log(`  投影幕    ${base}/stage.html`);
  console.log(`  玩家入口  ${base}/play.html      ← 做成 QR 貼出去`);
  console.log(`  主控台    ${base}/console.html`);
  console.log("=".repeat(60));
  console.log("  ⚠️  dist 要用 VITE_WS_URL=auto 建，否則前端會連去 Fly.io。");
  console.log("  ⚠️  全場要連同一個 Wi-Fi。開場前務必實測 AP 撐不撐得住 100 台。");
  console.log("=".repeat(60));
});

process.on("SIGINT", () => {
  game.kill();
  process.exit(0);
});
