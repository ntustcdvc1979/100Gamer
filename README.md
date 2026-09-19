# 百人派對遊戲

100+ 人同時用手機連線的現場互動遊戲。投影幕跑遊戲，玩家用手機當搖桿，分隊對抗。

| 頁面 | 給誰 |
|---|---|
| `stage.html` | 投影幕。唯一做全域訂閱、負責所有運算與渲染的客戶端。 |
| `play.html` | 玩家手機。輸入名字、自動分隊、搖桿。 |
| `index.html` | 入口。QR code 與開場前檢查清單。 |
| `server/` | 遊戲伺服器。純中繼，跑在 Fly.io 東京。 |

## 三個遊戲

順序是刻意的，一場派對的起承轉合：

| | 遊戲 | 型態 | 現場在做什麼 |
|---|---|---|---|
| 1 | **聚沙成塔** | 全體協作 | 投影幕上有一個鏤空的字，所有人把光點推進去填滿。沒有輸家，目的是讓 100 個人在 30 秒內學會用搖桿 |
| 2 | **四方拔河** | 分組對抗 | 大球在中間，四隊各自往自己的顏色區推。三戰兩勝 |
| 3 | **選邊站** | 個人賽 | 出題，畫面分四個象限，大家移到自己的選擇。有標準答案的題目答對得分，沒答案的題目「少數派」得分 |

兩個設計上的堅持：

- **四方拔河的隊伍推力用「平均」不是「總和」。** 分隊是照座位號輪流發的，
  但現場一定會有人中途離線、有人手機沒電。用總和的話人多的隊直接贏，比賽就沒意義了。
- **畫面上要顯示「參與率」。** 這一關好玩的地方不是體力，是看到自己隊上
  有八個人在放空——那個數字會讓全隊自己吼起來。

要加新遊戲就實作 [`src/stage/games/types.ts`](src/stage/games/types.ts) 的 `Game` 介面，
加進 [`games/index.ts`](src/stage/games/index.ts) 的陣列。**加之前先想延遲**：
端到端約 60ms，不要做需要精準時序判定的（誰先按、節奏、瞄準），
那些在百人場會變成純運氣。

改題目動 [`src/config/questions.ts`](src/config/questions.ts)，
改要拼的字動 `games/gather.ts` 的 `SHAPES`。

### 鍵盤

<kbd>→</kbd> 下一關（遊戲可以先吃掉，例如換題目、換字）　<kbd>←</kbd> 上一關
　<kbd>T</kbd> 開始／暫停　<kbd>R</kbd> 重來　<kbd>F</kbd> 全螢幕　<kbd>Esc</kbd> 關卡選單

## 開始之前

**必看** [`docs/SETUP.md`](docs/SETUP.md)：Fly.io 建置、GitHub 設定、壓力測試、現場手冊。

```bash
npm install
npm run server     # 另一個終端機
npm run dev
```

什麼都不設定就跑**本機模式**（BroadcastChannel），同一台電腦開幾個分頁就是幾個玩家。
彩排想先看 100 人的畫面長什麼樣：

```bash
npm run fake -- --clients 100
```

## 三條不能違反的規則

這個架構撐得住 100 人，靠的是**非對稱扇出**。違反任何一條，人數一上來就會卡死：

1. **手機只寫自己、只讀 `state`。** 永遠不訂閱 `players` 或 `inputs`。
   120 人互相訂閱是 O(n²) = 每秒 29 萬則訊息。
   （`room.onPlayers()` / `room.onInputs()` 在 play 角色下會直接丟例外，擋住這個錯誤。）
2. **只有投影幕做全域訂閱。** 它是唯一看得到所有人的客戶端。
3. **`state` 要小、要低頻。** 即時座標只活在投影幕的記憶體裡
   （[`src/stage/render.ts`](src/stage/render.ts)），永遠不寫回 `state`。

節流不是靠自律，是寫在 [`src/net/room.ts`](src/net/room.ts) 裡的：送出頻率依傳輸層自動套用
（見 [`src/config/settings.ts`](src/config/settings.ts) 的 `RATES`），而且內容沒變就不送。

`state` 裡唯一一個明知會變大還是放進去的欄位是選邊站的 `options`——
大禮堂後排看不清楚投影幕，四個選項一定要出現在自己手機上。四段短字約 100 bytes，值得。

## 傳輸層

連線層是一個介面（[`src/net/transport.ts`](src/net/transport.ts)），有三個實作。
**遊戲程式只能依賴這個介面，不准直接 import firebase 或 WebSocket。**
這道紀律已經回本過一次——從 Firebase 換成 WebSocket 時，`stage/` 和 `play/` 一行都沒改。

| | 用在哪 | 搖桿頻率 |
|---|---|---|
| `websocket.ts` | **主線**。Fly.io 東京，實測 120 人 **p95 = 59ms** | **20 Hz** |
| `firebase.ts` | 備援。RTDB 每次寫入都算錢，被迫壓低頻率 | 5 Hz |
| `local.ts` | 開發與離線降級。BroadcastChannel | 20 Hz |

降級順序：**遊戲伺服器 → Firebase → 本機模式**，投影幕永遠跑得動。

壓力測試要**拆成多個處理程序**跑，不然量到的是測試程式自己的 event loop 排隊時間：
單一處理程序打 Fly 得到 p95 = 2502ms，拆開之後是 59ms。做法見 [SETUP](docs/SETUP.md)。

## 檔案

```
src/
  net/
    transport.ts    介面
    websocket.ts    遊戲伺服器實作（主線）
    firebase.ts     Firebase 實作（備援，動態 import 切成獨立 chunk）
    local.ts        BroadcastChannel 實作（開發與離線降級）
    room.ts         對外 API：自動降級 + 節流 + 內容沒變就不送
    schema.ts       RoomState / Player / Input
  stage/
    main.ts         鍵盤流程與 rAF 迴圈
    canvas.ts       dpr-aware 畫布
    render.ts       玩家的世界（位置只活在這裡，不寫回 state）
    games/          三個遊戲，各自實作 Game 介面
  play/             手機端：加入、分隊、虛擬搖桿
  config/           房號、隊數、頻率、題庫
  shared/           隊伍、節流、QR、共用樣式
server/
  index.js          遊戲伺服器。刻意不用 TypeScript、不用 build step
  fly.toml          Fly.io 設定
scripts/
  fakeplayers.ts    假玩家，彩排時拿來看畫面
  loadtest-ws.ts    壓力測試（主線）
  loadtest.ts       壓力測試（Firebase）
docs/
  SETUP.md              設定與現場手冊
  database.rules.json   Firebase 安全規則
```

[`src/shared/qrcode.js`](src/shared/qrcode.js) 是從
[ntustcdvc1979/orientation](https://github.com/ntustcdvc1979/orientation)
搬過來的自製 QR 產生器，不依賴任何外部服務。

## 資料與隱私

玩家只留一個名字（暱稱即可）和搖桿數值，不收任何聯絡方式。
伺服器的房間資料只活在記憶體裡，重啟就沒了。
有用 Firebase 備援的話，活動結束後照 SETUP.md 最後一節把資料刪掉。
