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
import { openRoom, type Room } from "../net/room";
import { TEAMS, TEAM_IDS, type TeamId } from "../shared/teams";
import { colorScore, fromHex, toHex, type Rgb } from "../shared/color";
import { outlinePath } from "../shared/taiwan";
import { createJoystick } from "./input";
import { keepAwake } from "./wakelock";
import { readPhoto } from "./camera";
import { requestMotion, watchMotion } from "./flip";
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
  let room: Room;
  try {
    room = await openRoom("play");
  } catch (e) {
    joinHint.textContent = (e as Error).message || "連不上，請重新整理看看。";
    console.error(e);
    return;
  }

  if (room.kind === "local") {
    setStatus(false, "本機模式");
  } else {
    setStatus(false, "連線中…");
    room.onConnection((ok) => setStatus(ok, ok ? "已連線" : "連線中斷"));
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
    void join(room, nameInput.value.trim(), picked);
  });
}

async function join(room: Room, name: string, team: TeamId): Promise<void> {
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

  startPlaying(room, name, team);
}

function startPlaying(room: Room, name: string, team: TeamId): void {
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

  /* ---------- 感應器狀態（火候達人與搖動都看這一格）---------- */
  const sensorEl = $("sensor");
  setInterval(() => {
    const live = motion.sensing || shaker.sensing;
    sensorEl.classList.toggle("on", live);
    if (live) {
      sensorEl.textContent = "✓ 已偵測到感應器";
    } else if (control === "shake") {
      // 搖動那三關沒有按鈕備援，所以提示要指向「開啟感應器」那顆，
      // 不能還寫「請用按鈕」—— 那顆按鈕已經不在了。
      sensorEl.textContent = "✗ 沒有感應器，請按下面的「開啟感測器」";
    } else {
      sensorEl.textContent = "✗ 沒有偵測到感應器，請用按鈕";
    }
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
  const armBtn = $<HTMLButtonElement>("armBtn");

  function sendAct(ms: number, by: "motion" | "tap"): void {
    if (!armed) return;
    armed = false;
    motion.stop();
    $("motionHint").textContent = `你在 ${(ms / 1000).toFixed(2)} 秒動作`;
    actBtn.disabled = true;
    void room.sendAction({ k: "flip", ms, by });
  }

  // iOS 一定要從點擊事件裡要權限，而且拒絕之後要重新載入才能再問
  armBtn.addEventListener("click", () => {
    void (async () => {
      const r = await requestMotion();
      armBtn.hidden = r === "granted";
      $("motionHint").textContent =
        r === "granted" ? "感測器已開啟"
        : r === "denied" ? "沒有感測器權限，用下面的按鈕也可以"
        : "這支手機沒有感測器，用下面的按鈕";
    })();
  });
  $("armBtn2").addEventListener("click", () => armBtn.click());

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
          ? "手機螢幕朝上放好，時間到翻過來。感測器不能用就按上面的按鈕。"
          : gesture === "lift"
            ? "手機平放在桌上或手上，時間到整支拿起來。感測器不能用就按上面的按鈕。"
            : "手機拿好，時間到用力晃幾下。感測器不能用就按上面的按鈕。";

      if (accepting && !wasAccepting) {
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
      room.pushInput([0, 0], shaker.count);
      $("shakeCount").textContent = String(shaker.count);
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
