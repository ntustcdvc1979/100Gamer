/* ============================================================
   壓力測試 —— 第 3 週的 Go / No-Go

   模擬 N 支手機，每支以 SETTINGS.inputHz 的頻率寫 inputs/$uid，
   同時開一個「投影幕」訂閱全部輸入，量收到的延遲分佈。

   因為送出端和接收端都在同一台機器上，input.t 和收到的時間用的是
   同一個時鐘，這個延遲數字是可信的。

   跑法（先在 .env.local 填好 VITE_FIREBASE_CONFIG）：
     npm run loadtest -- --clients 120 --seconds 600

   判讀：
     p95 > 300ms          → 改設計或換傳輸層（寫一個 websocket.ts）
     收到的訊息數 << 送出  → RTDB 在丟訊息，同上
     Firebase 用量爆掉     → 降 inputHz，或縮小 Input 的欄位
   ============================================================ */

import { readFileSync } from "node:fs";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, set, onValue, remove } from "firebase/database";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]?.replace(/^--/, "");
  const v = process.argv[i + 1];
  if (k && v) args.set(k, v);
}

const CLIENTS = Number(args.get("clients") ?? 120);
const SECONDS = Number(args.get("seconds") ?? 120);
const HZ = Number(args.get("hz") ?? 5);
const ROOM = (args.get("room") ?? "LOADTEST").toUpperCase();

function loadConfig(): Record<string, string> {
  for (const file of [".env.local", ".env.production", ".env"]) {
    try {
      const line = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .find((l) => l.startsWith("VITE_FIREBASE_CONFIG="));
      if (line) return JSON.parse(line.slice("VITE_FIREBASE_CONFIG=".length)) as Record<string, string>;
    } catch {
      /* 換下一個檔 */
    }
  }
  throw new Error("找不到 VITE_FIREBASE_CONFIG，請先建 .env.local（見 .env.example）");
}

const cfg = loadConfig();
const latencies: number[] = [];
let received = 0;
let sent = 0;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[i] as number;
}

async function main(): Promise<void> {
  console.log(`房號 ${ROOM}｜${CLIENTS} 個客戶端 × ${HZ} Hz × ${SECONDS} 秒`);

  // ---- 投影幕：訂閱全部輸入 ----
  const stageApp = initializeApp(cfg, "stage");
  await signInAnonymously(getAuth(stageApp));
  const stageDb = getDatabase(stageApp);
  const seen = new Map<string, number>();

  onValue(ref(stageDb, `rooms/${ROOM}/inputs`), (snap) => {
    const now = Date.now();
    const all = (snap.val() ?? {}) as Record<string, { t?: number }>;
    for (const [uid, input] of Object.entries(all)) {
      const t = input?.t;
      if (typeof t !== "number" || seen.get(uid) === t) continue;
      seen.set(uid, t);
      received++;
      latencies.push(now - t);
    }
  });

  // ---- 手機：各自一個 app instance，才會拿到不同的匿名 uid ----
  const apps = [];
  for (let i = 0; i < CLIENTS; i++) {
    const app = initializeApp(cfg, `client-${i}`);
    const cred = await signInAnonymously(getAuth(app));
    apps.push({ app, db: getDatabase(app), uid: cred.user.uid });
    if ((i + 1) % 20 === 0) console.log(`  已連上 ${i + 1} / ${CLIENTS}`);
  }
  console.log("全部連上，開始送輸入…");

  const timers = apps.map(({ db, uid }, i) =>
    setInterval(() => {
      // 每個人轉不同的圈，模擬真的有人在搖
      const phase = (Date.now() / 1000 + i) % (Math.PI * 2);
      sent++;
      void set(ref(db, `rooms/${ROOM}/inputs/${uid}`), {
        v: [Math.cos(phase), Math.sin(phase)],
        t: Date.now(),
      }).catch(() => {});
    }, 1000 / HZ),
  );

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
  console.log("\n===== 結果 =====");
  console.log(`送出 ${sent}｜收到 ${received}（掉 ${(100 - (received / sent) * 100).toFixed(1)}%）`);
  console.log(`p50 ${quantile(s, 0.5)}ms｜p95 ${quantile(s, 0.95)}ms｜p99 ${quantile(s, 0.99)}ms`);
  console.log(quantile(s, 0.95) > 300 ? "❌ p95 超過 300ms —— 要改設計或換傳輸層" : "✅ 延遲可接受");
  console.log("記得去 Firebase 主控台看這一輪的用量與推估費用。");

  await remove(ref(stageDb, `rooms/${ROOM}`)).catch(() => {});
  await Promise.all([...apps.map((a) => deleteApp(a.app)), deleteApp(stageApp)]);
  process.exit(0);
}

void main();
