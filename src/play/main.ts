/* ============================================================
   手機端

   這一頁的三條紀律：
     1. 只訂閱 state，永遠不訂閱 players / inputs。
     2. 輸入交給 room.pushInput()／room.sendAction()，節流在連線層做掉。
     3. 頁面要小。100 人同時走行動網路連進來，每 10 KB 都有感。

   畫面依 state.control 換：
     joystick  虛擬搖桿（預設）
     camera    拍照找顏色 —— 照片不上傳，顏色在這支手機上算完
     flip      火候達人 —— 加速度計判定翻面，一定有按鈕備援
   ============================================================ */

import "../shared/base.css";
import "./play.css";
import { openRoom, type Room } from "../net/room";
import { SETTINGS } from "../config/settings";
import { TEAMS, teamForSeat, type TeamId } from "../shared/teams";
import { colorScore, fromHex, toHex } from "../shared/color";
import { createJoystick } from "./input";
import { keepAwake } from "./wakelock";
import { readPhoto } from "./camera";
import { requestMotion, watchFlip } from "./flip";
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
  const flipper = watchFlip();

  const say = $("say");
  const quads = $("quads");
  const padPane = $("pad");
  const camPane = $("camPane");
  const flipPane = $("flipPane");

  let control: RoomState["control"] = "joystick";
  let accepting = false;
  let targetHex = "";
  let flipArmed = false;

  /* ---------- 拍照找顏色 ---------- */
  const fileInput = $<HTMLInputElement>("shot");
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = ""; // 同一張照片要能再選一次
    if (!file || !accepting) return;
    void (async () => {
      $("camHint").textContent = "計算中…";
      try {
        const shot = await readPhoto(file);
        const hex = toHex(shot.rgb);
        const score = targetHex ? colorScore(fromHex(targetHex), shot.rgb) : 0;
        $<HTMLImageElement>("camPreview").src = shot.preview;
        $("camPreview").hidden = false;
        $("camSwatch").style.background = hex;
        $("camHint").textContent = `你拍到 ${hex}　${score} 分`;
        await room.sendAction({ k: "color", hex, score });
      } catch (e) {
        console.error(e);
        $("camHint").textContent = "這張讀不到，換一張試試";
      }
    })();
  });

  /* ---------- 火候達人 ---------- */
  const flipBtn = $<HTMLButtonElement>("flipBtn");
  const armBtn = $<HTMLButtonElement>("armBtn");

  function sendFlip(ms: number, by: "motion" | "tap"): void {
    if (!flipArmed) return;
    flipArmed = false;
    flipper.stop();
    $("flipHint").textContent = `你在 ${(ms / 1000).toFixed(2)} 秒翻面`;
    flipBtn.disabled = true;
    void room.sendAction({ k: "flip", ms, by });
  }

  // iOS 一定要從點擊事件裡要權限，而且拒絕之後要重新載入才能再問
  armBtn.addEventListener("click", () => {
    void (async () => {
      const r = await requestMotion();
      armBtn.hidden = r === "granted";
      $("flipHint").textContent =
        r === "granted" ? "翻面偵測已開啟"
        : r === "denied" ? "沒有感測器權限，用下面的按鈕也可以"
        : "這支手機沒有感測器，用下面的按鈕";
    })();
  });

  flipBtn.addEventListener("click", () => {
    if (!flipArmed) return;
    sendFlip(performance.now() - flipStartedAt, "tap");
  });

  let flipStartedAt = 0;

  /* ---------- state：手機唯一被允許訂閱的東西 ---------- */
  room.onState((s) => {
    say.textContent = s?.hint ?? "";
    const next = s?.control ?? "joystick";
    const wasAccepting = accepting;
    accepting = s?.accepting ?? false;
    targetHex = s?.targetColor ?? "";

    if (next !== control) {
      control = next;
      padPane.hidden = control !== "joystick";
      camPane.hidden = control !== "camera";
      flipPane.hidden = control !== "flip";
      $("camPreview").hidden = true;
      $("camHint").textContent = "";
      $("flipHint").textContent = "";
    }

    if (control === "camera") {
      $("camTarget").style.background = targetHex || "#888";
      $<HTMLButtonElement>("shotBtn").disabled = !accepting;
    }

    if (control === "flip") {
      $("flipTarget").textContent = s?.targetSeconds ? `${s.targetSeconds} 秒` : "—";
      // 這一輪剛開始：重新武裝
      if (accepting && !wasAccepting) {
        flipArmed = true;
        flipStartedAt = performance.now();
        flipBtn.disabled = false;
        $("flipHint").textContent = "螢幕朝上放好，時間到就翻過來";
        flipper.start((ms) => sendFlip(ms, "motion"));
      }
      if (!accepting) {
        flipArmed = false;
        flipper.stop();
        flipBtn.disabled = true;
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
    flipper.dispose();
    room.dispose();
  });
}

void main();
