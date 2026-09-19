# 設定與現場手冊

主線是 **Fly.io 上的遊戲伺服器**，Firebase 退成備援。
兩個都沒設也不會壞——網站會跑本機模式，投影幕照樣走得完。

---

## 一、遊戲伺服器（Fly.io）

### 為什麼是這個

WebSocket 的訊息幾乎免費，所以搖桿可以從 Firebase 被迫的 **5 Hz 拉到 20 Hz**。
對「每支手機當搖桿」這個玩法，這比延遲低 50ms 還有感。

實測打到東京（120 個客戶端 × 20 Hz）：**p50 50ms、p95 59ms、p99 63ms，零連線失敗**。

### 建立

```bash
# 裝 flyctl（Windows PowerShell）
iwr https://fly.io/install.ps1 -useb | iex

fly auth signup     # 或 fly auth login
cd server
fly launch --no-deploy --copy-config --name ntustcdvc-100gamer --region nrt
fly deploy
```

- **app 名字要全球唯一**。`ntustcdvc-100gamer` 被佔走的話換一個，
  記得同步改 [`server/fly.toml`](../server/fly.toml) 和 repo variable `VITE_WS_URL`。
- **region 選 `nrt`（東京）**，從台灣過去約 30–50ms，是所有選項裡最低的。
  備選 `hkg`（香港）。

部署完網址是 `https://<app>.fly.dev`，用瀏覽器打開會看到目前的房間與人數——
現場不用開終端機就能確認伺服器活著。

### 費用

| | |
|---|---|
| 平常（`min_machines_running = 0`） | 約 **US$0.15/月**（只剩 rootfs） |
| 活動期間（設 1，機器不休眠） | 約 **US$2/月** 的比例計費 |

Fly 的[免費方案已經取消](https://fly.io/pricing/)，要綁信用卡。
**綁完馬上去 Dashboard → Billing 設消費上限**，跟 Firebase 一樣的道理。

活動前一天把 `min_machines_running` 改成 `1` 重新部署，
避免第一個掃 QR 的人等冷啟動；活動結束改回 `0`。

### GitHub Actions 自動部署

1. 本機跑 `fly tokens create deploy -x 999999h`
2. 把 token 存成 repo secret **`FLY_API_TOKEN`**

之後改 `server/` 底下的檔案 push 上去就會自動部署
（[`deploy-server.yml`](../.github/workflows/deploy-server.yml) 只在 `server/**` 有變動時觸發——
改一行前端文案不該害現場的連線斷掉）。

---

## 二、讓前端連上伺服器

repo → **Settings → Secrets and variables → Actions → Variables** → New repository variable

| Name | Value |
|---|---|
| `VITE_WS_URL` | `wss://ntustcdvc-100gamer.fly.dev` |

**是 variable 不是 secret。** 它是公開網址，設成 secret 的話 Actions log 會把它遮成 `***`，
出事的時候查不了。

> **一定要 `wss://` 不能 `ws://`。** GitHub Pages 是 HTTPS，
> 瀏覽器會擋掉 HTTPS 頁面連 `ws://` 的 mixed content。
> 這也是「筆電在現場跑區網伺服器」行不通的原因。

Pages 本身：**Settings → Pages → Source** 選 **`GitHub Actions`**（不是 Deploy from a branch）。

---

## 三、Firebase（備援，可選）

伺服器掛了還有東西可以退。設了的話降級順序是
**遊戲伺服器 → Firebase → 本機模式**。只是 Firebase 模式下搖桿只有 5 Hz。

要做的話：

1. [Firebase Console](https://console.firebase.google.com) 新增專案 →
   **Realtime Database**（位置選 `asia-southeast1`）
2. **Authentication → Sign-in method → 匿名 → 啟用**
3. **規則**整段換成 [`docs/database.rules.json`](database.rules.json)
4. **升級 Blaze**（免費方案同時連線上限就是 100 人，一定會撞到），
   然後**馬上設 US$5 / US$10 兩段預算警示**
5. 設定值存成 repo secret **`FIREBASE_CONFIG`**（一整行 JSON，`databaseURL` 一定要有）

> 那把 web API key 不是密碼，它只識別專案、不授權存取。
> 真正的防線是那份規則（host 佔位 + `$uid === auth.uid`）和活動後刪資料。

---

## 四、開發

```bash
npm install
npm run server     # 另一個終端機：遊戲伺服器 localhost:8080
npm run dev
```

`.env.example` 複製成 `.env.local`，填 `VITE_WS_URL=ws://localhost:8080`
（本機可以用 `ws://`，因為 localhost 不受 mixed content 限制）。

什麼都不填就跑**本機模式**（BroadcastChannel）：同一台電腦開幾個分頁就是幾個玩家。

右下角那一格**不會騙人**：顯示「本機模式」就是手機沒有真的同步，
顯示「已連線」才是。開場前就是看這一格。

同一台電腦要模擬多個玩家的話，網址加 `?u=2`、`?u=3` 可以強制分身。

**寫程式時的三條紀律見 [README](../README.md)。** 最重要的一條：
手機端永遠不訂閱 `players` 或 `inputs`——`room.onPlayers()` 在 play 角色下會直接丟例外。

---

## 五、壓力測試（Go / No-Go）

**排在活動前三週，不要排在最後一週。**

### ⚠️ 一定要拆成多個處理程序跑

120 條連線 × 20 Hz = 每秒 2400 次 JSON 序列化加 TLS 加密，再加上解析投影幕
收到的批次。全擠在同一個 Node event loop 裡的話，量到的「延遲」會是自己的
排隊時間，不是網路。

這不是理論：同一台機器打同一個伺服器，**單一處理程序得到 p95 = 2502ms，
拆成四個處理程序之後是 p95 = 59ms**。差了 40 倍，而且錯的那個會讓你以為
架構不行。

開四個終端機：

```bash
npm run loadtest:ws -- --url wss://ntustcdvc-100gamer.fly.dev --mode recv --seconds 600
npm run loadtest:ws -- --url wss://ntustcdvc-100gamer.fly.dev --mode send --clients 40 --seconds 600
```

（後面那行開三個。）報告最後一行會印 event loop 的最大延遲，
超過 200ms 就代表上面的數字不能信，要再拆更細。

跑的時候**另外開一台真的 `stage.html`** 看畫面順不順。

| 看什麼 | 過關標準 |
|---|---|
| 延遲 p95 | **< 300ms**。目前基準：東京 59ms |
| event loop 最大延遲 | **< 200ms**，否則上面的延遲不可信 |
| 連線失敗數 | 0 |
| 投影幕幀率 | 畫 120 個物件不能掉幀 |
| `fly logs` / `fly status` | 記憶體沒有一路往上（漏連線） |

如果 p95 真的太高，第一個該調的是 `server/index.js` 的 `FLUSH_HZ`——
攤平的間隔會**整個加到延遲上**。設 20 Hz 時本機 p50 就有 64ms
（送出與攤平同為 50ms 週期會相位鎖死），改成 60 Hz 降到 30ms。

> 送出量只有目標的 8 成是正常的：Windows 的 setInterval 粒度是 15.6ms，
> 要求 50ms 實際會變成 62.5ms（16 Hz）。真手機是 rAF 驅動，不會有這個問題。

### 彩排：先看 100 人的畫面

```bash
npm run fake -- --clients 100
```

開 100 個有名字、有隊伍的假玩家連上去。活動前想知道百人的投影幕長什麼樣、
名字會不會擠在一起、四隊顏色分不分得開，用這個看。

---

## 六、現場當天

開場前 10 分鐘：

1. 用手機打開 `https://<app>.fly.dev`，確認伺服器活著。
2. 筆電接投影機，設成**延伸**而不是同步。
3. 瀏覽器開 `stage.html`，看右下角：**● 已連線**才算成功。
4. 按 <kbd>F</kbd> 全螢幕。
5. 自己拿手機掃一次 QR，確認名字有跳到投影幕上、人數有變成 1。

### 一定要準備的

| 項目 | 為什麼 |
|---|---|
| **備用筆電**，已開好頁面待命 | 主機掛掉時 30 秒接手。投影幕一斷線伺服器就把 host 讓出來，備用機能直接接手 |
| **筆電的行動網路熱點** | 投影幕是單點故障，不能只靠場地 Wi-Fi |
| **QR 印 6 張分散貼** | 100 人擠一張掃不到。每排座位一張，或印在椅背 |
| 短網址 | 掃不到的人要能手打 |
| 充電站／行動電源 | 100 人玩 30 分鐘體感遊戲，手機會燙、會沒電 |
| 現場協助人員 3–4 名 | 專門處理「我連不上」。百人場最容易失控的地方 |

### 出事的時候

**投影幕顯示「連線中斷」**
手機瀏覽器開 `https://<app>.fly.dev` 看伺服器在不在。
機器睡著了的話 `fly machine start`，或 `fly deploy` 重來一次。
客戶端本來就會自動重連（退避到 5 秒），通常不用做什麼。

**伺服器整個掛掉**
有設 Firebase 備援的話，把 repo variable `VITE_WS_URL` 清掉重新部署前端，
會自動退到 Firebase（搖桿變 5 Hz，但跑得完）。
來不及的話投影幕當純簡報用，流程不受影響。

**大量玩家連不上**
現場引導：關掉場地 Wi-Fi 改用自己的行動網路。
場地 AP 常常只撐得住 50–100 台，這是這次不依賴場地 Wi-Fi 的原因。

**想重跑一場（下午還有一梯）**
網址改成 `stage.html?r=PARTY2`，QR 會跟著變成 `play.html?r=PARTY2`。
伺服器的房間是獨立的，互不干擾。

---

## 七、活動之後

1. `server/fly.toml` 的 `min_machines_running` 改回 `0`，`fly deploy`。
   （想更省就 `fly apps destroy <app>`，下次再 `fly launch` 一次。）
2. 確認 Fly 的帳單沒有異常。
3. 有用 Firebase 備援的話：刪掉 `rooms` 節點、規則改回
   `".read": false, ".write": false`、考慮把 Blaze 降回 Spark。
