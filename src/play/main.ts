/* ============================================================
   手機端

   這一頁的三條紀律：
     1. 只訂閱 state，永遠不訂閱 players / inputs。
     2. 輸入交給 room.pushInput()／room.sendAction()，節流在連線層做掉。
     3. 頁面要小。100 人同時走行動網路連進來，每 10 KB 都有感。

   畫面依 state.control 換：
     （沒填）  什麼都不顯示，只有一句提示。搖桿不是預設值 ——
               大廳、等待的時候不該憑空冒出一個搖桿讓人亂推。
     joystick  虛擬搖桿
     camera    拍照找顏色 —— 可以重拍，但只能上傳一次
     flip      火候達人（煎）—— 翻面
     lift      火候達人（炸）—— 把手機提起來
   ============================================================ */

import "../shared/base.css";
import "./play.css";
import { openRoom, type Room } from "../net/room";
import { SETTINGS } from "../config/settings";
import { TEAMS, teamForSeat, type TeamId } from "../shared/teams";
import { colorScore, fromHex, toHex, type Rgb } from "../shared/color";
import { createJoystick } from "./input";
import { keepAwake } from "./wakelock";
import { readPhoto } from "./camera";
import { requestMotion, watchMotion } from "./flip";
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

async function main(): Promise<void> {
  let room: Room;
  try {
    room = await openRoom("play");
  } catch (e) {
    joinHint.textContent = "連不上，請重新整理看看。";
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

  const canJoin = (): boolean => nameInput.value.trim().length > 0;
  const refresh = (): void => {
    joinBtn.disabled = !canJoin();
  };
  nameInput.addEventListener("input", refresh);
  joinHint.textContent = "";
  refresh();

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && canJoin()) joinBtn.click();
  });

  joinBtn.addEventListener("click", () => {
    void join(room, nameInput.value.trim());
  });
}

async function join(room: Room, name: string): Promise<void> {
  joinBtn.disabled = true;
  joinHint.textContent = "加入中…";
  try {
    localStorage.setItem("p100:name", name);
  } catch {
    /* 忽略 */
  }

  let team: TeamId;
  try {
    // 座位號用 transaction 發，100 人同時按「加入」也不會撞號，
    // 隊伍人數因此保證平均。
    const seat = await room.takeSeat();
    team = teamForSeat(seat, SETTINGS.teamCount);
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

  const say = $("say");
  const quads = $("quads");
  const idlePane = $("idlePane");
  const padPane = $("pad");
  const camPane = $("camPane");
  const motionPane = $("motionPane");

  let control: RoomState["control"] | undefined;
  let accepting = false;
  let targetHex = "";
  let armed = false;
  let startedAt = 0;

  /* ---------- 拍照找顏色：可以重拍，只能上傳一次 ---------- */
  const fileInput = $<HTMLInputElement>("shot");
  const sendBtn = $<HTMLButtonElement>("sendShot");
  /** 手上這張還沒送出去的照片 */
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
    fileInput.value = ""; // 同一張照片要能再選一次
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
        // 不顯示分數 —— 分數要等時間到才公布，不然大家會站著微調刷分
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

  actBtn.addEventListener("click", () => {
    if (!armed) return;
    sendAct(performance.now() - startedAt, "tap");
  });

  /* ---------- state：手機唯一被允許訂閱的東西 ---------- */
  room.onState((s) => {
    say.textContent = s?.hint ?? "";
    const next = s?.control;
    const wasAccepting = accepting;
    accepting = s?.accepting ?? false;
    targetHex = s?.targetColor ?? "";

    if (next !== control) {
      control = next;
      // 沒有 control 就什麼都不顯示，只留一句提示
      idlePane.hidden = control !== undefined;
      padPane.hidden = control !== "joystick";
      camPane.hidden = control !== "camera";
      motionPane.hidden = control !== "flip" && control !== "lift";
      resetCamera();
      $("motionHint").textContent = "";
      armed = false;
      motion.stop();
    }

    if (control === "camera") {
      $("camTarget").style.background = targetHex || "#888";
      $<HTMLLabelElement>("shotLabel").classList.toggle("off", !accepting || uploaded);
      // 換題目了就解鎖，可以重新拍
      if (accepting && !wasAccepting) resetCamera();
      if (s?.revealed && uploaded && pending) {
        // 分數是這時候才算的，手機自己用同一套公式算一次就好，
        // 不用為了這個多開一條每人一份的通道。
        $("camHint").textContent = `你的分數 ${colorScore(fromHex(targetHex), pending.rgb)} 分`;
      }
    }

    if (control === "flip" || control === "lift") {
      const lift = control === "lift";
      $("motionTarget").textContent = s?.targetSeconds ? `${s.targetSeconds} 秒` : "—";
      $("motionVerb").textContent = lift ? "把手機提起來" : "把手機翻面";
      actBtn.textContent = lift ? "起鍋！" : "翻面！";
      $("motionFine").textContent = lift
        ? "手機平放在桌上或手上，時間到整支拿起來。感測器不能用就按上面的按鈕。"
        : "手機螢幕朝上放好，時間到翻過來。感測器不能用就按上面的按鈕。";

      // 這一輪剛開始：重新武裝
      if (accepting && !wasAccepting) {
        armed = true;
        startedAt = performance.now();
        actBtn.disabled = false;
        $("motionHint").textContent = lift ? "放好，自己數秒數" : "螢幕朝上放好，自己數秒數";
        motion.start(lift ? "lift" : "flip", (ms) => sendAct(ms, "motion"));
      }
      if (!accepting) {
        armed = false;
        motion.stop();
        actBtn.disabled = true;
      }
    }

    const options = s?.options ?? [];
    quads.hidden = options.length !== 4;
    if (!quads.hidden) {
      [...quads.children].forEach((el, i) => {
        el.textContent = options[i] ?? "";
      });
      $("padHint").textContent = "往你的選擇推";
    } else {
      $("padHint").textContent = "按住並移動";
    }
  });

  // 每幀讀搖桿、丟給連線層。節流在 room 裡面做，這裡可以放心每幀呼叫。
  let raf = 0;
  const loop = (): void => {
    if (control === "joystick") {
      room.pushInput([stick.value[0], stick.value[1]]);
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(raf);
    stick.dispose();
    motion.dispose();
    room.dispose();
  });
}

void main();
