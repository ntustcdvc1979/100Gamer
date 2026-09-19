/* ============================================================
   壓力測試（遊戲伺服器版）—— 第 3 週的 Go / No-Go

   模擬 N 支手機連上 WebSocket 伺服器，每支以指定頻率送搖桿，
   同時開一個「投影幕」連線量收到的延遲分佈。

   送出端和接收端在同一台機器上，input.t 和收到的時間用同一個時鐘，
   所以這個延遲數字是可信的（它量的是「手機 → 伺服器 → 投影幕」的來回）。

   ⚠️ 一個處理程序塞不下 120 條連線

   120 個客戶端 × 20 Hz = 每秒 2400 次 JSON.stringify + TLS 加密，
   同時還要解析投影幕收到的批次。全擠在同一個 Node event loop 裡的話，
   量到的「延遲」會是自己的 event loop 排隊時間，不是網路。
   實測過：單一處理程序打 Fly 得到 p95 = 2502ms，拆開之後是 p95 = 121ms。

   所以打遠端一定要拆開跑（mode）：
     --mode recv   只接收、只量延遲。開一個。
     --mode send   只送出。開三個，每個 40 人。
     --mode all    兩者都做（預設）。只有本機小規模測試才適合。

   跑法：
     本機   npm run loadtest:ws -- --url ws://localhost:8080 --clients 40

     Fly（開四個終端機）
       npm run loadtest:ws -- --url wss://<app>.fly.dev --mode recv --seconds 600
       npm run loadtest:ws -- --url wss://<app>.fly.dev --mode send --clients 40 --seconds 600
       （再兩個同樣的 send）

   判讀：
     p95 > 300ms          → 改設計（降頻率、縮小 payload）或換區域
     收到 << 送出          → 伺服器在丟訊息或連線不穩
     伺服器記憶體/CPU 爆   → fly.toml 調大 vm
   ============================================================ */

import WebSocket from "ws";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]?.replace(/^--/, "");
  const v = process.argv[i + 1];
  if (k && v) args.set(k, v);
}

const URL_BASE = args.get("url") ?? "ws://localhost:8080";
const CLIENTS = Number(args.get("clients") ?? 40);
const SECONDS = Number(args.get("seconds") ?? 120);
const HZ = Number(args.get("hz") ?? 20);
const ROOM = (args.get("room") ?? "LOADTEST").toUpperCase();
const MODE = (args.get("mode") ?? "all") as "all" | "send" | "recv";

const latencies: number[] = [];
let received = 0;
let sent = 0;
let connectErrors = 0;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[i] as number;
}

function open(role: "stage" | "play"): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`${URL_BASE}?r=${ROOM}&role=${role}`);
    sock.once("open", () => resolve(sock));
    sock.once("error", reject);
  });
}

/** 量 event loop 有沒有塞住。這個數字大代表量到的延遲是自己造成的。 */
function watchEventLoop(): () => number {
  let worst = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last - 50);
    last = now;
  }, 50);
  timer.unref?.();
  return () => worst;
}

async function main(): Promise<void> {
  console.log(
    `${URL_BASE}｜房號 ${ROOM}｜mode=${MODE}` +
      (MODE === "recv" ? "" : `｜${CLIENTS} 個客戶端 × ${HZ} Hz`) +
      `｜${SECONDS} 秒`,
  );
  const lagOf = watchEventLoop();

  // ---- 投影幕：收伺服器攤平後的輸入批次 ----
  let stage: WebSocket | null = null;
  if (MODE !== "send") {
    stage = await open("stage");
    stage.on("message", (raw) => {
      const now = Date.now();
      let m: { t?: string; v?: Record<string, { t?: number }> };
      try {
        m = JSON.parse(raw.toString()) as typeof m;
      } catch {
        return;
      }
      if (m.t !== "inputs" || !m.v) return;
      for (const input of Object.values(m.v)) {
        if (typeof input?.t !== "number") continue;
        received++;
        latencies.push(now - input.t);
      }
    });
  }

  // ---- 手機 ----
  const socks: WebSocket[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  if (MODE !== "recv") {
    for (let i = 0; i < CLIENTS; i++) {
      try {
        socks.push(await open("play"));
      } catch {
        connectErrors++;
      }
      if ((i + 1) % 20 === 0) console.log(`  已連上 ${socks.length} / ${i + 1}`);
    }
    console.log(`全部連上（失敗 ${connectErrors}），開始送輸入…`);

    for (const [i, sock] of socks.entries()) {
      timers.push(
        setInterval(() => {
          if (sock.readyState !== WebSocket.OPEN) return;
          // 每個人轉不同的圈，模擬真的有人在搖
          const phase = (Date.now() / 1000 + i) % (Math.PI * 2);
          sent++;
          sock.send(
            JSON.stringify({ t: "input", v: { v: [Math.cos(phase), Math.sin(phase)], t: Date.now() } }),
          );
        }, 1000 / HZ),
      );
    }
  }

  const report = setInterval(() => {
    const s = [...latencies].sort((a, b) => a - b);
    console.log(
      `  送出 ${sent}｜收到 ${received}｜` +
        `p50 ${quantile(s, 0.5)}ms  p95 ${quantile(s, 0.95)}ms  p99 ${quantile(s, 0.99)}ms`,
    );
  }, 10_000);

  await new Promise((r) => setTimeout(r, SECONDS * 1000));

  timers.forEach(clearInterval);
  clearInterval(report);

  const s = [...latencies].sort((a, b) => a - b);
  const lag = lagOf();
  console.log("\n===== 結果 =====");
  if (MODE !== "recv") {
    const expected = CLIENTS * HZ * SECONDS;
    console.log(
      `連線失敗 ${connectErrors} / ${CLIENTS}｜送出 ${sent} / 應送 ${expected}` +
        `（${((sent / expected) * 100).toFixed(0)}%）`,
    );
  }
  if (MODE !== "send") {
    // 伺服器把輸入攤平成批次再轉給投影幕，所以「收到」比「送出」少是正常的。
    console.log(`投影幕收到 ${received} 筆`);
    console.log(`p50 ${quantile(s, 0.5)}ms｜p95 ${quantile(s, 0.95)}ms｜p99 ${quantile(s, 0.99)}ms`);
    console.log(quantile(s, 0.95) > 300 ? "❌ p95 超過 300ms" : "✅ 延遲可接受");
  }
  // 這一行比上面的延遲更重要：塞住的話上面的數字全都不能信。
  console.log(
    `event loop 最大延遲 ${lag}ms` +
      (lag > 200 ? "　⚠️ 測試程式自己塞住了，上面的延遲不可信，請拆成多個處理程序" : "　（健康）"),
  );

  socks.forEach((x) => x.close());
  stage?.close();
  process.exit(0);
}

void main();
