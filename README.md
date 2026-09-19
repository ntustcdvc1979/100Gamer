# 百人派對遊戲

100+ 人同時用手機連線的現場互動遊戲。投影幕跑遊戲，玩家用手機當搖桿，分隊對抗。

| 頁面 | 給誰 |
|---|---|
| `stage.html` | 投影幕。唯一做全域訂閱、負責所有運算與渲染的客戶端。 |
| `play.html` | 玩家手機。輸入名字、自動分隊、搖桿。 |
| `index.html` | 入口。QR code 與開場前檢查清單。 |
| `server/` | 遊戲伺服器。純中繼，跑在 Fly.io 東京。 |

## 開始之前

**必看** [`docs/SETUP.md`](docs/SETUP.md)：Fly.io 建置、GitHub 設定、壓力測試、現場手冊。

```bash
npm install
npm run server     # 另一個終端機
npm run dev
```

什麼都不設定就跑**本機模式**（BroadcastChannel），同一台電腦開幾個分頁就是幾個玩家，
一個人也能測完整流程。

## 三條不能違反的規則

這個架構撐得住 100 人，靠的是**非對稱扇出**。違反任何一條，人數一上來就會卡死：

1. **手機只寫自己、只讀 `state`。** 永遠不訂閱 `players` 或 `inputs`。
   120 人互相訂閱是 O(n²) = 每秒 29 萬則訊息。
   （`room.onPlayers()` / `room.onInputs()` 在 play 角色下會直接丟例外，擋住這個錯誤。）
2. **只有投影幕做全域訂閱。** 它是唯一看得到所有人的客戶端。
3. **`state` 要小、要低頻。** 即時座標只活在投影幕的記憶體裡
   （[`src/stage/render.ts`](src/stage/render.ts)），永遠不寫回 `state`。

節流不是靠自律，是寫在 [`src/net/room.ts`](src/net/room.ts) 裡的。
實際頻率依傳輸層而定，見 [`src/config/settings.ts`](src/config/settings.ts) 的 `RATES`。

## 傳輸層

連線層是一個介面（[`src/net/transport.ts`](src/net/transport.ts)），有三個實作。
**遊戲程式只能依賴這個介面，不准直接 import firebase 或 WebSocket。**
這道紀律已經回本過一次——從 Firebase 換成 WebSocket 時，`stage/` 和 `play/` 一行都沒改。

| | 用在哪 | 搖桿頻率 |
|---|---|---|
| `websocket.ts` | **主線**。Fly.io 東京，實測 120 人 p95 = 31ms | **20 Hz** |
| `firebase.ts` | 備援。RTDB 每次寫入都算錢，被迫壓低頻率 | 5 Hz |
| `local.ts` | 開發與離線降級。BroadcastChannel | 20 Hz |

降級順序：**遊戲伺服器 → Firebase → 本機模式**，投影幕永遠跑得動。

```bash
npm run loadtest:ws -- --url wss://<app>.fly.dev --clients 120 --seconds 600
```

## 檔案

```
src/
  net/
    transport.ts    介面
    websocket.ts    遊戲伺服器實作（主線）
    firebase.ts     Firebase 實作（備援，動態 import 切成獨立 chunk）
    local.ts        BroadcastChannel 實作（開發與離線降級）
    room.ts         對外 API：自動降級 + 節流
    schema.ts       RoomState / Player / Input
  stage/            投影幕：Canvas 渲染、鍵盤流程
  play/             手機端：加入、分隊、虛擬搖桿
  shared/           隊伍、節流、QR、共用樣式
server/
  index.js          遊戲伺服器。刻意不用 TypeScript、不用 build step
  fly.toml          Fly.io 設定
scripts/
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
