/* ============================================================
   手機端

   三條紀律：
     1. 只訂閱 state，永遠不訂閱 players / inputs。
     2. 輸入交給 room.pushInput()／room.sendAction()，節流在連線層做掉。
     3. 頁面要小。100 人同時走行動網路連進來，每 10 KB 都有感。

   畫面依 state.control 換：
     （沒填）  什麼都不顯示，只有一句提示。搖桿不是預設值。
     joystick  虛擬搖桿
     camera    拍照找顏色 —— 可以重拍，只能上傳一次
     motion    火候達人 —— 在指定秒數做一次動作（翻面／提起／晃動）
     shake     一直搖（拔河／賽跑／拔蘿蔔）
     tap       在台灣地圖上點位置（地理達人）
     find      在字陣裡找出不一樣的字
   ============================================================ */

import "../shared/base.css";
import "./play.css";
import { AccessDenied, openRoom, type Room } from "../net/room";
import { TEAMS, TEAM_IDS, type TeamId } from "../shared/teams";
import { colorScore, fromHex, toHex, type Rgb } from "../shared/color";
import { outlinePath } from "../shared/taiwan";
import { createJoystick } from "./input";
import { keepAwake } from "./wakelock";
import { readPhoto } from "./camera";
import { requestMotion, watchMotion, type FlipSupport } from "./flip";
import { createShakeCounter } from "./shake";
import type { RoomState } from "../net/schema";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const joinScreen = $("joinScreen");
const playScreen = $("playScreen");
const nameInput = $<HTMLInputElement>("name");
const joinBtn = $<HTMLButtonElement>("joinBtn");
const joinHint = $("joinHint");
const statusEl = $("status");
const statusText = $("statusText");

function setStatus(ok: boolean, text: string): void {
  statusEl.classList.toggle("on", ok);
  statusText.textContent = text;
}

/** 種子亂數，要跟 stage/games/findchar.ts 的算法一模一樣。 */
function seededIndex(seed: number, count: number): number {
  let x = seed >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5;
  x >>>= 0;
  return x % count;
}

async function main(): Promise<void> {
  /* 第一次就連不上要自己重試，不能叫玩家重新整理。
     一百支手機在同一分鐘內掃 QR，伺服器打嗝一下是很正常的；
     而「請重新整理」這句話在現場的實際效果是那個人放棄玩了。
     連上之後的斷線由 websocket.ts 自己處理，這裡只管開場那一次。 */
  let room: Room;
  for (let attempt = 1; ; attempt++) {
    try {
      room = await openRoom("play");
      break;
    } catch (e) {
      if (e instanceof AccessDenied) {
        joinHint.textContent = e.message; // 被踢出去的人，重試也沒用
        return;
      }
      console.error(e);
      joinHint.textContent = `連線中…（第 ${attempt} 次）`;
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
    }
  }
  joinHint.textContent = "";

  if (room.kind === "local") {
    setStatus(false, "本機模式");
  } else {
    setStatus(false, "連線中…");
    // 「重新連線中」而不是「連線中斷」：程式真的正在重連，
    // 講「中斷」會讓人去重新整理，那反而更慢（要重新選隊、重新拿權限）。
    room.onConnection((ok) => setStatus(ok, ok ? "已連線" : "重新連線中…"));
  }

  try {
    nameInput.value = localStorage.getItem("p100:name") ?? "";
  } catch {
    /* 無痕模式，忽略 */
  }

  /* ---------- 選隊 ---------- */
  let picked: TeamId | null = null;
  const teamBox = $("teams");
  teamBox.innerHTML = TEAM_IDS.map((id) => {
    const t = TEAMS[id];
    // --c 選中時的底色、--b 邊框、--t 沒選中時的字色、--k 選中時的字色。
    //
    // 風象是白的，所以字色和邊框都不能直接沿用隊色 ——
    // 那會變成白底白字、白邊白底，整顆按鈕在畫面上消失。
    const text = t.light ? "#6B6B75" : t.color;
    const border = t.light ? "#B9B9C2" : t.color;
    return (
      `<button type="button" class="teamBtn" data-t="${id}" ` +
      `style="--c:${t.color};--b:${border};--t:${text};--k:${t.ink}">` +
      `<span class="tn">${t.name}</span><span class="tc" data-c="${id}">—</span></button>`
    );
  }).join("");

  teamBox.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".teamBtn");
    if (!btn) return;
    picked = btn.dataset.t as TeamId;
    [...teamBox.children].forEach((el) =>
      el.classList.toggle("on", (el as HTMLElement).dataset.t === picked),
    );
    refresh();
  });

  // 人數顯示：讓大家自己去補人少的隊。沒有這個的話一定會有一隊爆滿。
  room.onState((s) => {
    const counts = s?.teamCounts ?? [];
    TEAM_IDS.forEach((id, i) => {
      const el = teamBox.querySelector(`[data-c="${id}"]`);
      if (el) el.textContent = `${counts[i] ?? 0} 人`;
    });
  });

  const canJoin = (): boolean => nameInput.value.trim().length > 0 && picked !== null;
  const refresh = (): void => {
    joinBtn.disabled = !canJoin();
    joinHint.textContent = picked === null ? "還要選一隊" : "";
  };
  nameInput.addEventListener("input", refresh);
  refresh();

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && canJoin()) joinBtn.click();
  });

  joinBtn.addEventListener("click", () => {
    if (!picked) return;

    /* 感測器權限在這裡要，不要另外放一顆「開啟感測器」。
       iOS 規定 requestPermission() 一定要從使用者的點擊事件裡呼叫，
       所以一定要有「一次點擊」—— 而「加入遊戲」本來就是每個人都會按的
       那一下，拿它來要權限，沒有人會漏。

       以前是在遊戲畫面上放一顆按鈕，結果是：那顆按鈕沒人注意到，
       於是一整場都沒有權限、一則 devicemotion 都收不到，
       火候達人感應器沒反應、拔蘿蔔的計數一直是 0，都是同一個原因。

       注意是先要權限再送出加入 —— await 之後就不算使用者手勢了，
       所以這一行不能放到 savePlayer 後面。 */
    const ask = requestMotion();
    void join(room, nameInput.value.trim(), picked, ask);
  });
}

async function join(
  room: Room,
  name: string,
  team: TeamId,
  motionAsk: Promise<FlipSupport>,
): Promise<void> {
  joinBtn.disabled = true;
  joinHint.textContent = "加入中…";
  try {
    localStorage.setItem("p100:name", name);
  } catch {
    /* 忽略 */
  }

  try {
    await room.savePlayer({ name, team, joinedAt: Date.now() });
  } catch (e) {
    console.error(e);
    joinHint.textContent = "加入失敗，再按一次試試。";
    joinBtn.disabled = false;
    return;
  }

  startPlaying(room, name, team, await motionAsk);
}

function startPlaying(room: Room, name: string, team: TeamId, motionOk: FlipSupport): void {
  const def = TEAMS[team];
  joinScreen.hidden = true;
  playScreen.hidden = false;

  document.body.style.background = def.color;
  document.body.style.color = def.ink;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", def.color);
  $("teamName").textContent = def.name;
  $("myName").textContent = name;

  keepAwake();

  const stick = createJoystick($("pad"), $("knob"));
  const motion = watchMotion();
  const shaker = createShakeCounter();

  const say = $("say");
  const quads = $("quads");
  const panes = {
    idle: $("idlePane"),
    joystick: $("pad"),
    camera: $("camPane"),
    motion: $("motionPane"),
    shake: $("shakePane"),
    tap: $("tapPane"),
    find: $("findPane"),
  };

  let control: RoomState["control"] | undefined;
  let gesture: RoomState["gesture"] = "flip";
  let accepting = false;
  let targetHex = "";
  let armed = false;
  let startedAt = 0;
  /** 這一關開始時的搖動累計數。畫面上顯示的是「現在 - 這個」。 */
  let shakeBase = 0;
  /** 已經記過基準的那一關。 */
  let shakeKey = "";
  /** 已經備妥過的那一題。見下面 control === "motion" 的說明。 */
  let motionRoundKey = "";

  /* ---------- 感應器狀態（火候達人與搖動都看這一格）---------- */
  const sensorEl = $("sensor");
  setInterval(() => {
    const live = motion.sensing || shaker.sensing;
    sensorEl.classList.toggle("on", live);
    if (live) {
      sensorEl.textContent = "✓ 已偵測到感應器";
      armBtn2.hidden = true;
      return;
    }
    if (control === "shake") {
      // 搖動那三關沒有動作鈕可以代替，所以要指一條活路出來
      sensorEl.textContent =
        motionOk === "denied"
          ? "✗ 沒有感測器權限，按下面那顆重新開啟"
          : "✗ 沒有偵測到感應器，把手機拿在手上試試";
      armBtn2.hidden = false;
      return;
    }
    // 火候達人：感測器不能用就按動作鈕，那顆一直在，不用另外開什麼
    sensorEl.textContent = "✗ 沒有偵測到感應器，直接按下面的按鈕";
  }, 500);

  /* ---------- 拍照找顏色 ---------- */
  const fileInput = $<HTMLInputElement>("shot");
  const sendBtn = $<HTMLButtonElement>("sendShot");
  let pending: { rgb: Rgb; thumb: string } | null = null;
  let uploaded = false;

  function resetCamera(): void {
    pending = null;
    uploaded = false;
    $("camPreview").hidden = true;
    $("camSwatch").hidden = true;
    sendBtn.hidden = true;
    sendBtn.disabled = false;
    sendBtn.textContent = "就是這張，上傳";
    $("camHint").textContent = "";
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file || !accepting || uploaded) return;
    void (async () => {
      $("camHint").textContent = "處理中…";
      try {
        const shot = await readPhoto(file);
        pending = shot;
        const img = $<HTMLImageElement>("camPreview");
        img.src = shot.thumb;
        img.hidden = false;
        const swatch = $("camSwatch");
        swatch.style.background = toHex(shot.rgb);
        swatch.hidden = false;
        sendBtn.hidden = false;
        // 不顯示分數 —— 要等時間到才公布
        $("camHint").textContent = "可以重拍，滿意再上傳";
      } catch (e) {
        console.error(e);
        $("camHint").textContent = "這張讀不到，換一張試試";
      }
    })();
  });

  sendBtn.addEventListener("click", () => {
    if (!pending || uploaded || !accepting) return;
    uploaded = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "已上傳，等公布";
    $("camHint").textContent = "等時間到公布分數";
    void room.sendAction({ k: "color", hex: toHex(pending.rgb), thumb: pending.thumb });
  });

  /* ---------- 火候達人 ---------- */
  const actBtn = $<HTMLButtonElement>("actBtn");

  function sendAct(ms: number, by: "motion" | "tap"): void {
    if (!armed) return;
    armed = false;
    motion.stop();
    $("motionHint").textContent = `你在 ${(ms / 1000).toFixed(2)} 秒動作`;
    actBtn.disabled = true;
    void room.sendAction({ k: "flip", ms, by });
  }

  /* 搖動關卡的最後手段：權限在加入時就要過了，但 iOS 上有人會手滑按到
     「不允許」。iOS 的規則是拒絕之後要重新載入頁面才能再問，所以這顆
     按不出結果時要老實講「重新整理」，不要讓人一直按。 */
  const armBtn2 = $<HTMLButtonElement>("armBtn2");
  armBtn2.addEventListener("click", () => {
    void requestMotion().then((r) => {
      $("sensor").textContent =
        r === "granted" ? "✓ 感測器已開啟" : "✗ 要不到權限，請重新整理這一頁再試";
    });
  });

  actBtn.addEventListener("click", () => {
    if (!armed) return;
    sendAct(performance.now() - startedAt, "tap");
  });

  /* ---------- 搖手機 ----------
     這三關**沒有**按鈕備援。按按鈕比搖手機快得多，留著就等於
     開一條合法的作弊路徑，整關的比較會失去意義。
     火候達人不一樣：它比的是「時間點」不是「次數」，按鈕不會比較快，
     所以那一關保留備援，讓感測器壞掉的人也能玩。 */

  /* ---------- 地理達人：台灣地圖 ---------- */
  const mapSvg = $("map");
  let tapped = false;
  mapSvg.innerHTML =
    `<svg viewBox="0 0 100 170" width="100%" height="100%" aria-label="台灣地圖">` +
    `<path d="${outlinePath(100, 170)}" fill="rgba(255,255,255,.22)" stroke="currentColor" stroke-width="1.2"/>` +
    `<g id="mates"></g>` +
    `<circle id="mapPin" r="3.5" fill="#fff" stroke="currentColor" stroke-width="1.4" style="display:none"/>` +
    `</svg>`;

  // 隊友點在哪。伺服器只會送自己這一隊的（它知道每個人的隊伍），
  // 所以這裡拿到的就是隊友，不是全場一百個人。
  //
  // 畫成半透明的小點，自己那一顆是實心白的大點 —— 一眼分得出來。
  room.onPins((pins) => {
    const mates = mapSvg.querySelector("#mates");
    if (!mates) return;
    mates.innerHTML = pins
      .map(
        ([x, y]) =>
          `<circle cx="${(x * 100).toFixed(1)}" cy="${(y * 170).toFixed(1)}" ` +
          `r="2" fill="currentColor" opacity=".45"/>`,
      )
      .join("");
  });

  mapSvg.addEventListener("click", (e) => {
    // 可以一直改，時間到才算。
    //
    // 原本擋成「一人一次」是怕有人用二分搜尋逼近答案 —— 但分數本來就
    // 等時間到才公布，過程中沒有任何回饋可以逼近，擋掉只是讓手滑點錯的人
    // 整題報銷。
    if (!accepting) return;
    const r = mapSvg.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    tapped = true;
    const pin = mapSvg.querySelector<SVGCircleElement>("#mapPin");
    if (pin) {
      pin.setAttribute("cx", String(x * 100));
      pin.setAttribute("cy", String(y * 170));
      pin.style.display = "";
    }
    $("tapHint").textContent = "已標記，還可以再改";
    void room.sendAction({ k: "tap", x, y });
  });

  /* ---------- 文字找不同 ---------- */
  const findGrid = $("findGrid");
  let findDone = false;
  let findStartedAt = 0;

  function buildGrid(s: RoomState): void {
    const rows = s.rows ?? 6;
    const cols = s.cols ?? 8;
    const normal = s.options?.[0] ?? "人";
    const odd = s.options?.[1] ?? "入";
    const oddAt = seededIndex(s.seed ?? 1, rows * cols);
    findGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    findGrid.innerHTML = Array.from({ length: rows * cols }, (_, i) =>
      `<button type="button" class="cell" data-i="${i}">${i === oddAt ? odd : normal}</button>`,
    ).join("");
    findDone = false;
    findStartedAt = performance.now();
    $("findHint").textContent = "";
  }

  findGrid.addEventListener("click", (e) => {
    if (!accepting || findDone) return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".cell");
    if (!cell) return;
    findDone = true;
    cell.classList.add("picked");
    $("findHint").textContent = "已送出，等公布";
    void room.sendAction({ k: "find", i: Number(cell.dataset.i), ms: performance.now() - findStartedAt });
  });

  /* ---------- state：手機唯一被允許訂閱的東西 ---------- */
  let lastRoundKey = "";
  room.onState((s) => {
    say.textContent = s?.hint ?? "";
    const next = s?.control;
    const wasAccepting = accepting;
    accepting = s?.accepting ?? false;
    targetHex = s?.targetColor ?? "";
    gesture = s?.gesture ?? "flip";

    if (next !== control) {
      control = next;
      for (const [k, el] of Object.entries(panes)) {
        el.hidden = k !== (control ?? "idle");
      }
      resetCamera();
      $("motionHint").textContent = "";
      armed = false;
      motion.stop();
    }

    // 感應器那一格只有用得到的關卡才顯示
    sensorEl.hidden = control !== "motion" && control !== "shake";

    if (control === "shake") {
      // 拔蘿蔔是「拉」，拔河和賽跑是「搖」。判定門檻差很多 ——
      // 用同一組參數的話，狂甩的人會被當成在狂拉。
      const pull = gesture === "lift";
      shaker.setMode(pull ? "pull" : "shake");
      $("shakeBig").textContent = pull ? "⬆️" : "🫨";
      $("shakeVerb").textContent = pull ? "把手機往上拉！" : "用力搖手機！";

      /* 手機上的數字要跟投影幕算的是同一個東西。
         shaker.count 是「這支手機開頁以來總共動了幾下」，永遠不歸零 ——
         直接顯示的話，玩過拔河再去拔蘿蔔，畫面上會是上一關累積的幾百下，
         而投影幕算的是這一關從零開始的數量。兩邊講的不是同一件事。

         所以顯示的是「這一關開始到現在」：換關卡或重新開始時記下基準，
         畫面上顯示的是差值。投影幕那邊 ShakeMeter 也是在同一個時機
         重抓基準（run(true) 會 drain、reset 會 reset），所以兩邊對得起來。

         送出去的還是累計值，不要動 —— 那是為了掉封包也補得回來。 */
      const key = `${s?.game}:${s?.round}`;
      if (key !== shakeKey) {
        shakeKey = key;
        shakeBase = shaker.count;
      }
      if (accepting && !wasAccepting) shakeBase = shaker.count;

      // 單位講清楚，「3」是三根蘿蔔還是三下才不用猜
      $("shakeUnit").textContent =
        s?.game === "shakecarrot" ? "根" : s?.game === "shakerun" ? "步" : "下";
    }

    if (control === "camera") {
      $("camTarget").style.background = targetHex || "#888";
      $("shotLabel").classList.toggle("off", !accepting || uploaded);
      if (accepting && !wasAccepting) resetCamera();
      if (s?.revealed && uploaded && pending) {
        $("camHint").textContent = `你的分數 ${colorScore(fromHex(targetHex), pending.rgb)} 分`;
      }
    }

    if (control === "motion") {
      const verb = gesture === "lift" ? "把手機提起來" : gesture === "shake" ? "晃手機" : "把手機翻面";
      $("motionTarget").textContent = s?.targetSeconds ? `${s.targetSeconds} 秒` : "—";
      $("motionVerb").textContent = verb;
      actBtn.textContent = verb + "！";
      $("motionFine").textContent =
        gesture === "flip"
          ? "手機螢幕朝上放好，算準時間翻過來。若不能用感測器則按按鈕。"
          : gesture === "lift"
            ? "算準時間將手機往上提起。若不能用感測器則按按鈕。"
            : "手機拿好，算準時間用力晃幾下。若不能用感測器則按按鈕。";

      /* 備妥的條件是「剛開始」**或**「這一題還沒備過」，兩個都要。

         只看 accepting 的上升緣不夠：斷線重連或中途才進來的人，
         拿到的 state 前後都是 accepting=true，沒有緣可看 ——
         那個人整題的按鈕都是灰的，感測器也沒 start，
         畫面看起來一切正常，就是動了沒反應。

         但只看題號也不行：主持人按「重來」再按「開始」是同一題，
         題號沒變，那樣就換成所有人都備不起來。 */
      const roundKey = `${s?.game}:${s?.round}:${s?.targetSeconds}`;
      if (accepting && (!wasAccepting || roundKey !== motionRoundKey)) {
        motionRoundKey = roundKey;
        armed = true;
        startedAt = performance.now();
        actBtn.disabled = false;
        $("motionHint").textContent = "放好，自己數秒數";
        motion.start(gesture, (ms) => sendAct(ms, "motion"));
      }
      if (!accepting) {
        armed = false;
        motion.stop();
        actBtn.disabled = true;
      }
    }

    if (control === "tap") {
      $("tapPlace").textContent = s?.place ?? "";
      // 換題目就解鎖
      const key = `${s?.game}:${s?.round}`;
      if (key !== lastRoundKey) {
        lastRoundKey = key;
        tapped = false;
        const pin = mapSvg.querySelector<SVGCircleElement>("#mapPin");
        if (pin) pin.style.display = "none";
        const mates = mapSvg.querySelector("#mates");
        if (mates) mates.innerHTML = "";
      }
      // 提示要每次都更新，不能只在換題目時設 ——
      // 主持人按開始的時候題號沒變，提示就會卡在「等主持人開始」。
      if (!accepting) {
        $("tapHint").textContent = tapped ? "時間到，等公布" : "等主持人開始";
      } else if (!tapped) {
        $("tapHint").textContent = "在地圖上點一下（可以一直改）";
      }
    }

    if (control === "find") {
      const key = `${s?.game}:${s?.round}:${s?.seed}`;
      if (s && key !== lastRoundKey) {
        lastRoundKey = key;
        buildGrid(s);
      }
    }

    const options = s?.options ?? [];
    quads.hidden = control !== "joystick" || options.length !== 4;
    if (!quads.hidden) {
      [...quads.children].forEach((el, i) => {
        el.textContent = options[i] ?? "";
      });
      $("padHint").textContent = "往你的選擇推";
    } else {
      $("padHint").textContent = "按住並移動";
    }
  });

  // 每幀讀搖桿／搖動計數，丟給連線層。節流在 room 裡面做。
  let raf = 0;
  const loop = (): void => {
    if (control === "joystick") {
      room.pushInput([stick.value[0], stick.value[1]]);
    } else if (control === "shake") {
      // 送累計值（掉封包補得回來），畫面顯示這一關的數量（跟投影幕同一個數）
      room.pushInput([0, 0], shaker.count);
      $("shakeCount").textContent = String(Math.max(0, shaker.count - shakeBase));
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(raf);
    stick.dispose();
    motion.dispose();
    shaker.dispose();
    room.dispose();
  });
}

void main();
