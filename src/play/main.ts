/* ============================================================
   手機端

   這一頁的三條紀律：
     1. 只訂閱 state，永遠不訂閱 players / inputs。
     2. 輸入交給 room.pushInput()，節流在連線層做掉。
     3. 頁面要小。100 人同時走行動網路連進來，每 10 KB 都有感 ——
        不載字型、不載圖片、firebase 走動態 import 切成獨立 chunk。
   ============================================================ */

import "../shared/base.css";
import "./play.css";
import { openRoom, type Room } from "../net/room";
import { SETTINGS } from "../config/settings";
import { TEAMS, teamForSeat, type TeamId } from "../shared/teams";
import { createJoystick } from "./input";
import { keepAwake } from "./wakelock";

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
    // 本機模式一定要看得出來。這一格被蓋成「已連線」的話，主持人會以為
    // 手機都同步好了才開場 —— 那是現場最貴的誤會。
    setStatus(false, "本機模式");
  } else {
    setStatus(false, "連線中…");
    room.onConnection((ok) => setStatus(ok, ok ? "已連線" : "連線中斷"));
  }

  // 名字之前填過就帶回來，重整不用再打一次。
  try {
    nameInput.value = localStorage.getItem(`p100:${room.code}:name`) ?? "";
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
    localStorage.setItem(`p100:${room.code}:name`, name);
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

  // 每幀讀搖桿、丟給連線層。節流（SETTINGS.inputHz）在 room 裡面做，
  // 這裡可以放心每幀呼叫。
  let raf = 0;
  const loop = (): void => {
    room.pushInput([stick.value[0], stick.value[1]]);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(raf);
    stick.dispose();
    room.dispose();
  });
}

void main();
