/* ============================================================
   3D 皮克敏

   照主視覺 group.png 與遊戲裡的皮克敏建的模型：燈泡形的大頭、亮面的大眼睛、
   細手細腳、沒有手指的尖尖小手，頭頂收成一個尖、直接長出一根莖，
   莖的尾端是葉子、花苞或花（同一隊裡三種都有，每一隻固定一種）。
     紅：尖鼻子、葉子        黃：一對大尖耳、花
     藍：嘴巴、葉子          白：紅眼睛沒有眼白、比較瘦、花

   世界單位：腳底在 y=0，頭頂的葉子／花大約到 y=1。

   ⚠️ 莖一定要接在頭上。
   莖和葉子是一起擺動的，擺動的支點必須是「頭頂」—— 支點放在別的地方
   （例如腳底），轉一點點角度莖的根部就會離開頭頂，看起來葉子飄在半空。
   頭的輪廓也是一路收尖到莖的粗細，兩者之間沒有縫。

   ⚠️ 動作是連續的，不是一格一格的圖。
   以前是把幾個姿勢先拍成圖再貼，腳步只有 8 格、待機只有 4 格，
   看起來像定格動畫。現在整個畫面的皮克敏在同一個 3D 場景裡每幀一起算：
   同一個零件（例如所有紅皮克敏的左眼）用 InstancedMesh 一次畫完，
   一百隻也只要一兩百次繪製呼叫，每一隻的姿勢都是當下算的，完全連續。

   用法：遊戲照常呼叫 cartoon.ts 的 pikmin()，它只是「排進佇列」；
   在要蓋到皮克敏上面的東西（名字、木牌）之前呼叫 flushPikmin()，
   佇列裡的皮克敏會一次算好貼到 2D 畫布上。stage/main.ts 每幀結束時也會
   再 flush 一次，漏掉的不會不見。
   ============================================================ */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { TEAM_IDS, type TeamId } from "../../shared/teams";
import { blobShadow, toy } from "./studio";

export interface Pose3D {
  /** 走路的相位（一個完整步伐 = 1，連續往上加）。undefined = 站著 */
  walk?: number;
  /** 待機呼吸的相位（連續往上加） */
  idle?: number;
  /** 慶祝（舉手歡呼或揮手，照個體決定是哪一種） */
  celebrate?: boolean;
  /** 往後仰（拔蘿蔔），弧度，負的是往後 */
  lean?: number;
  /** 兩手往前伸（抓著東西拉） */
  reach?: boolean;
  /** 兩手舉高扛著東西（賽跑扛蘿蔔） */
  carry?: boolean;
  /** 眨眼的程度 0..1 */
  blink?: number;
  /** 戴廚師帽 */
  chef?: boolean;
  /** 頭上長的是什麼：0 葉子、1 花苞、2 花 */
  bloom?: 0 | 1 | 2;
  /**
   * 這一隻是誰（整數種子）。同一隻每幀都要給一樣的值：
   * 關節角度是跟著「上一幀的這一隻」慢慢轉過去的，動作才不會一下跳到定位。
   * 閒著沒事時做哪個小動作，也是用它決定的。
   */
  key?: number;
  /** 現在的時間（毫秒）。沒給就不做平滑，直接擺到定位。 */
  time?: number;
}

/* ------------------------------------------------------------
   模型
   ------------------------------------------------------------ */

/** 3D 裡顏色會被色調映射壓暗一點，底色比 2D 的隊伍色再飽和一些。 */
const BODY: Record<TeamId, string> = {
  A: "#E0231A",
  B: "#2F6FEA",
  C: "#FFC928",
  D: "#F6F7FA",
};

/** 花瓣和花苞的顏色。白皮克敏的頭是白的，白花會跟頭糊在一起，改成淡粉紅。 */
const PETAL: Record<TeamId, string> = {
  A: "#FFFFFF",
  B: "#FFFFFF",
  C: "#FFFFFF",
  D: "#FFB3CF",
};

/** 莖從頭頂長出來的位置（沒戴帽子時） */
const STEM_BASE = 0.77;
/** 上半身轉動的支點（腰） */
const HIP = 0.17;

interface Rig {
  root: THREE.Group; // 放在場景裡的最外層：位置、大小、朝向
  lean: THREE.Group; // 以腳底為軸，在畫面平面上前後仰；跳起來也是它
  turn: THREE.Group; // 轉成四分之三側面
  upper: THREE.Group; // 上半身，以腰為軸轉頭、歪頭、往後伸懶腰
  body: THREE.Group; // 會上下彈的部分
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  eyes: THREE.Object3D[];
  hat: THREE.Group;
  /** 莖＋葉子／花苞／花。支點在頭頂 —— 轉它，根部不會離開頭 */
  sprout: THREE.Group;
  /** 葉子、花苞、花三組，一次只亮一組 */
  blooms: [THREE.Group, THREE.Group, THREE.Group];
  /** 所有 Mesh，照固定順序。instancing 的每一個零件對應其中一個。 */
  meshes: THREE.Mesh[];
}

function limb(r: number, len: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 12), mat);
  // 膠囊預設是站直、中心在原點；改成從原點往下垂，關節好轉
  m.position.y = -len / 2 - r * 0.5;
  return m;
}

/**
 * 頭：燈泡形，最寬的地方在中間，往上一路收細，
 * 頂端收到跟莖一樣細 —— 莖是「長出來」的，不是插上去的。
 */
function headGeometry(team: TeamId): THREE.LatheGeometry {
  const w = team === "D" ? 0.9 : team === "C" ? 1.05 : 1;
  const pts = [
    [0, 0.33], [0.085, 0.338], [0.138, 0.37], [0.165, 0.43], [0.17, 0.5],
    [0.158, 0.57], [0.128, 0.63], [0.088, 0.68], [0.05, 0.72], [0.022, 0.755],
    [0.011, STEM_BASE + 0.01], [0, STEM_BASE + 0.012],
  ].map(([r, y]) => new THREE.Vector2((r as number) * w, y as number));
  const curve = new THREE.SplineCurve(pts);
  return new THREE.LatheGeometry(curve.getPoints(48), 48);
}

/**
 * 手掌：真的皮克敏沒有手指，手是一個尖尖的小「手套」——
 * 上面圓、往指尖收尖，扁扁的。用球捏出來：下半部越往下越窄。
 */
function handGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.024, 16, 12);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = y < 0 ? 1 + (y / 0.024) * 0.62 : 1; // 越往下越窄
    pos.setXYZ(i, pos.getX(i) * k * 0.9, y * 1.7, pos.getZ(i) * k * 0.55);
  }
  geo.computeVertexNormals();
  return geo;
}

/** 葉子：一片前端尖尖、中間稍微拱起來的葉片，根部在原點、往 +x 長 */
function leafGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.1, 28, 16);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i) * 0.13;
    let z = pos.getZ(i) * 0.5;
    const t = (x + 0.1) / 0.2; // 0 = 根部，1 = 葉尖
    // 葉尖收尖、根部收一點點，最寬在三分之一處（像真的皮克敏那片葉子）
    const width = Math.sin(Math.PI * Math.pow(t, 0.75)) * (1 - t * 0.25);
    z *= width / Math.max(0.05, Math.sqrt(Math.max(0, 1 - (x / 0.1) ** 2)));
    // 沿著中線對折一點、葉尖往上翹
    y += Math.abs(z) * 0.35 + t * t * 0.03;
    x += 0.1;
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** 花苞：水滴形，底部圓、頂端收尖，根部在原點往 +y 長 */
function budGeometry(): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const r = 0.046 * Math.sin(Math.PI * Math.pow(t, 0.62)) * (1 - t * 0.15);
    pts.push(new THREE.Vector2(Math.max(0.0005, r), t * 0.125));
  }
  pts.push(new THREE.Vector2(0, 0.125));
  return new THREE.LatheGeometry(pts, 24);
}

function buildRig(team: TeamId): Rig {
  const color = BODY[team];
  const skin = toy(color);
  const limbMat = toy(team === "D" ? "#E9ECF2" : new THREE.Color(color).multiplyScalar(0.9).getStyle());
  const dark = toy("#121218", { rough: 0.15, coat: 1 });
  const white = toy("#FFFFFF", { rough: 0.12, coat: 1 });
  const glintMat = toy("#FFFFFF", { rough: 0, coat: 0 });
  const green = toy("#4DB23A", { rough: 0.45, coat: 0.2 });
  const stemMat = toy("#3F8A2C", { rough: 0.5, coat: 0.1 });
  const petal = toy(PETAL[team], { rough: 0.5, coat: 0.2 });

  const root = new THREE.Group();
  root.add(blobShadow(0.2));
  const lean = new THREE.Group();
  root.add(lean);
  const turn = new THREE.Group();
  lean.add(turn);
  const upper = new THREE.Group();
  upper.position.y = HIP;
  turn.add(upper);
  const body = new THREE.Group();
  body.position.y = -HIP;
  upper.add(body);

  // 腳：細細的腿，末端一個小小的腳掌
  const mkLeg = (x: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, 0.165, 0);
    g.add(limb(0.022, 0.11, limbMat));
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 10), limbMat);
    foot.scale.set(0.85, 0.5, 1.45);
    foot.position.set(0, -0.15, 0.014);
    g.add(foot);
    turn.add(g); // 腳不跟身體彈
    return g;
  };
  const legL = mkLeg(-0.04);
  const legR = mkLeg(0.04);

  // 身體：小小的橢圓
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.075, 32, 20), skin);
  torso.scale.set(1, 1.3, 0.95);
  torso.position.y = 0.245;
  body.add(torso);

  // 手：細細長長的手臂，末端是尖尖的小手套（沒有手指）
  const handGeo = handGeometry();
  const mkArm = (x: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, 0.3, 0);
    g.add(limb(0.014, 0.12, limbMat));
    const hand = new THREE.Mesh(handGeo, limbMat);
    hand.position.y = -0.165;
    g.add(hand);
    body.add(g);
    return g;
  };
  const armL = mkArm(-0.064);
  const armR = mkArm(0.064);

  // 頭
  body.add(new THREE.Mesh(headGeometry(team), skin));

  // 眼睛：又大又靠前，兩顆幾乎貼在一起、微微鼓出來
  const eyes: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(s * 0.06, 0.5, 0.135);
    eye.rotation.y = s * 0.25;
    if (team === "D") {
      // 白皮克敏：一雙紅眼睛，沒有眼白
      const iris = new THREE.Mesh(new THREE.SphereGeometry(0.05, 24, 16), toy("#D61F2B", { rough: 0.1, coat: 1 }));
      iris.scale.z = 0.62;
      eye.add(iris);
    } else {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.058, 24, 16), white);
      ball.scale.z = 0.66;
      eye.add(ball);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.034, 20, 14), dark);
      pupil.position.set(0.006, -0.004, 0.028);
      pupil.scale.z = 0.55;
      eye.add(pupil);
    }
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.011, 10, 8), glintMat);
    glint.position.set(-0.006, 0.017, 0.042);
    eye.add(glint);
    body.add(eye);
    eyes.push(eye);
  }

  if (team === "A") {
    // 紅皮克敏：長長的尖鼻子，微微朝下
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.11, 18), skin);
    nose.rotation.x = Math.PI / 2 + 0.3;
    nose.position.set(0, 0.425, 0.195);
    body.add(nose);
  } else if (team === "B") {
    // 藍皮克敏：嘴巴
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.034, 16, 10), toy("#0E1B45", { rough: 0.3 }));
    mouth.scale.set(1, 0.5, 0.35);
    mouth.position.set(0, 0.405, 0.16);
    body.add(mouth);
  } else if (team === "C") {
    // 黃皮克敏：一對往兩邊翹的大尖耳
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.26, 20), skin);
      ear.scale.z = 0.32;
      ear.position.set(s * 0.21, 0.57, -0.01);
      ear.rotation.z = -s * 1.1;
      body.add(ear);
    }
  }

  // 廚師帽（平常藏起來）
  const hat = new THREE.Group();
  const hatMat = toy("#FFFFFF", { rough: 0.6, coat: 0.1 });
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.095, 0.06, 32), hatMat);
  band.position.y = 0.665;
  hat.add(band);
  for (const [x, y, r] of [[-0.05, 0.73, 0.065], [0.05, 0.73, 0.065], [0, 0.77, 0.07]] as const) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), hatMat);
    puff.position.set(x, y, 0);
    hat.add(puff);
  }
  hat.visible = false;
  body.add(hat);

  /* 莖＋葉子／花苞／花。整組的原點就是頭頂，擺動時繞著頭頂轉。
     真的皮克敏是「葉 → 花苞 → 花」三個階段，同一隊裡三種都有。 */
  const sprout = new THREE.Group();
  sprout.position.y = STEM_BASE;
  const stemCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.012, 0), // 從頭頂裡面一點點開始，保證接得上
    new THREE.Vector3(0.006, 0.07, 0),
    new THREE.Vector3(0.03, 0.15, -0.008),
    new THREE.Vector3(0.07, 0.2, -0.014),
  ]);
  sprout.add(new THREE.Mesh(new THREE.TubeGeometry(stemCurve, 20, 0.0095, 8), stemMat));
  const tip = new THREE.Vector3(0.07, 0.2, -0.014);

  // 葉子：根部接在莖的尾端，葉尖往外斜上
  const leafG = new THREE.Group();
  leafG.position.copy(tip);
  leafG.rotation.set(0.35, 0, 0.3);
  leafG.add(new THREE.Mesh(leafGeometry(), green));
  const vein = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0018, 0.17, 6), stemMat);
  vein.rotation.z = Math.PI / 2;
  vein.position.set(0.085, 0.006, 0);
  leafG.add(vein);
  sprout.add(leafG);

  // 花苞：順著莖的方向長出去的水滴，底下三片小綠萼
  const budG = new THREE.Group();
  budG.position.copy(tip);
  budG.rotation.z = -0.7;
  const bud = new THREE.Mesh(budGeometry(), petal);
  budG.add(bud);
  for (let k = 0; k < 3; k++) {
    const sep = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), green);
    const a = (k / 3) * Math.PI * 2;
    sep.scale.set(0.45, 1.3, 0.25);
    sep.position.set(Math.cos(a) * 0.02, 0.016, Math.sin(a) * 0.02);
    sep.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
    budG.add(sep);
  }
  sprout.add(budG);

  // 花：五片花瓣，朝著鏡頭斜上方開
  const flowerG = new THREE.Group();
  flowerG.position.copy(tip);
  flowerG.rotation.set(1.1, 0, 0.2);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.042, 16, 10), petal);
    p.scale.set(1, 0.3, 0.55);
    p.position.set(Math.cos(a) * 0.046, 0, Math.sin(a) * 0.046);
    p.rotation.y = -a;
    flowerG.add(p);
  }
  const center = new THREE.Mesh(new THREE.SphereGeometry(0.024, 16, 12), toy("#FFC21F", { rough: 0.5 }));
  center.position.y = 0.01;
  center.scale.y = 0.6;
  flowerG.add(center);
  sprout.add(flowerG);
  body.add(sprout);

  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  return { root, lean, turn, upper, body, legL, legR, armL, armR, eyes, hat, sprout, blooms: [leafG, budG, flowerG], meshes };
}

/* ------------------------------------------------------------
   姿勢

   分兩層：
   1. 關節目標角度（手、上半身、朝向、莖）—— 每一幀先算「應該擺在哪」，
      再從上一幀的角度「慢慢轉過去」（指數平滑，時間常數約 70 毫秒）。
      所以從垂手變成舉手揮動，是一個看得到的抬手過程，不會一幀就跳上去。
   2. 腳步、彈跳、眨眼 —— 本來就是連續的曲線，直接用。

   站著沒事做的皮克敏，每隔幾秒會自己做一個小動作（揮手、東張西望、
   跳一跳、歡呼、伸懶腰、跳舞、抓頭、歪頭），做哪一個、什麼時候做，
   由個體的 key 決定 —— 一群站在一起也不會同時做同一件事。
   ------------------------------------------------------------ */

const AL_X = 0, AL_Y = 1, AL_Z = 2, AR_X = 3, AR_Y = 4, AR_Z = 5;
const U_RY = 6, U_RZ = 7, U_RX = 8, SP_Z = 9, SP_X = 10, TURN = 11;
const JOINTS = 12;

type Act = "none" | "wave" | "look" | "hop" | "cheer" | "stretch" | "sway" | "scratch" | "tilt";
const ACTS: Act[] = ["none", "wave", "look", "hop", "cheer", "stretch", "sway", "scratch", "tilt", "none", "look"];

function hash(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function smooth01(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/** 閒著的時候現在在做什麼：act、強度 e（0..1，頭尾都是緩緩進出）、動作開始後幾秒 u */
function idleAct(key: number, sec: number): { act: Act; e: number; u: number } {
  const SLOT = 6;
  const shifted = sec + (key % 997) * 0.613;
  const slot = Math.floor(shifted / SLOT);
  const local = shifted - slot * SLOT;
  const act = ACTS[Math.floor(hash(key * 131 + slot * 7919) * ACTS.length)] ?? "none";
  const dur = 2.6 + hash(key + slot * 17) * 1.4;
  const start = 0.4 + hash(key * 7 + slot * 3) * (SLOT - dur - 0.8);
  const u = local - start;
  if (act === "none" || u < 0 || u > dur) return { act: "none", e: 0, u: 0 };
  return { act, e: smooth01(u / 0.5) * smooth01((dur - u) / 0.5), u };
}

interface Extra {
  hop: number;
  blink: number;
}

/** 算關節的目標角度，寫進 out；回傳不需要平滑的部分 */
function poseTargets(p: Pose3D, face: 1 | -1, out: Float32Array): Extra {
  const walk = p.walk;
  const swing = walk === undefined ? 0 : Math.sin(walk * Math.PI * 2);
  const idle = p.idle ?? 0;
  const breathe = Math.sin(idle * Math.PI * 2);
  const key = p.key ?? 0;
  const sec = (p.time ?? 0) / 1000;
  let hop = 0;
  let blink = p.blink ?? 0;

  // 基本：手微微張開往下垂，走路時前後擺，站著時跟著呼吸輕輕晃
  out[AL_X] = -swing * 0.55; out[AL_Y] = 0; out[AL_Z] = -0.3 - breathe * 0.04;
  out[AR_X] = swing * 0.55; out[AR_Y] = 0; out[AR_Z] = 0.3 + breathe * 0.04;
  out[U_RY] = 0; out[U_RZ] = 0; out[U_RX] = walk === undefined ? 0 : 0.08; // 走路時身體微微前傾
  out[SP_Z] = walk === undefined ? breathe * 0.12 : -0.18 + swing * 0.1;
  out[SP_X] = walk === undefined ? Math.sin(idle * Math.PI * 1.3) * 0.06 : 0;
  // 朝右或朝左：轉身而不是鏡射（鏡射會把模型翻成裡外相反）
  out[TURN] = face * 0.32;

  if (p.reach) {
    out[AL_X] = -1.25; out[AL_Z] = -0.15;
    out[AR_X] = -1.25; out[AR_Z] = 0.15;
  }
  if (p.carry) {
    // 兩手舉高過頭，扛著東西
    out[AL_X] = 0; out[AL_Z] = -2.75 + swing * 0.08;
    out[AR_X] = 0; out[AR_Z] = 2.75 + swing * 0.08;
  }

  let act: Act = "none";
  let e = 0;
  let u = 0;
  if (p.celebrate) {
    // 慶祝：一半的皮克敏雙手舉高歡呼，一半的用力揮手
    act = key % 2 === 0 ? "cheer" : "wave";
    e = 1;
    u = sec + (key % 13) * 0.21;
  } else if (walk === undefined && !p.reach && !p.carry && p.key !== undefined) {
    ({ act, e, u } = idleAct(key, sec));
  }
  if (act === "none" || e <= 0) return { hop, blink };

  const tau = Math.PI * 2;
  const mix = (i: number, v: number): void => {
    out[i] = (out[i] as number) + (v - (out[i] as number)) * e;
  };
  switch (act) {
    case "wave":
      // 右手舉起來左右揮，另一手自然垂著，身體跟著晃一點
      mix(AR_Z, 2.45 + Math.sin(u * tau * 1.8) * 0.38);
      mix(AR_X, -0.3);
      mix(U_RZ, -0.06 + Math.sin(u * tau * 1.8) * 0.03);
      break;
    case "look":
      // 東張西望：先看一邊、再看另一邊
      mix(U_RY, Math.sin(u * tau * 0.4) * 0.6);
      mix(U_RZ, Math.sin(u * tau * 0.4) * 0.06);
      break;
    case "hop":
      // 原地蹦蹦跳，兩手張開
      hop = Math.abs(Math.sin(u * Math.PI * 2.4)) * 0.08 * e;
      mix(AL_Z, -0.9); mix(AR_Z, 0.9);
      break;
    case "cheer": {
      // 雙手舉高上下晃，小小跳著
      const b = Math.sin(u * tau * 2);
      mix(AL_Z, -2.55 + b * 0.22); mix(AR_Z, 2.55 - b * 0.22);
      mix(AL_X, -0.15); mix(AR_X, -0.15);
      hop = Math.abs(Math.sin(u * Math.PI * 4)) * 0.035 * e;
      break;
    }
    case "stretch":
      // 伸懶腰：雙手往上伸直、身體往後仰、眼睛瞇起來
      mix(AL_Z, -2.95); mix(AR_Z, 2.95);
      mix(AL_X, 0.15); mix(AR_X, 0.15);
      mix(U_RX, -0.2);
      blink = Math.max(blink, 0.85 * e);
      break;
    case "sway": {
      // 跳舞：左右擺、雙手張開跟著擺
      const b = Math.sin(u * tau * 1.1);
      mix(U_RZ, b * 0.2);
      mix(AL_Z, -1.1 + b * 0.35); mix(AR_Z, 1.1 + b * 0.35);
      hop = Math.abs(b) * 0.02 * e;
      break;
    }
    case "scratch":
      // 抓頭：右手舉到頭側邊來回抓，頭歪一邊
      mix(AR_Z, 2.25);
      mix(AR_X, -0.95 + Math.sin(u * tau * 4) * 0.14);
      mix(U_RZ, 0.12);
      break;
    case "tilt":
      // 好奇地歪頭，雙手背在後面
      mix(U_RZ, 0.24); mix(U_RY, 0.22);
      mix(AL_X, 0.55); mix(AR_X, 0.55);
      mix(AL_Z, -0.12); mix(AR_Z, 0.12);
      break;
  }
  return { hop, blink };
}

/** 把姿勢套到骨架上。j 是（平滑過的）關節角度。 */
function applyPose(r: Rig, p: Pose3D, j: ArrayLike<number>, extra: Extra): void {
  const walk = p.walk;
  const swing = walk === undefined ? 0 : Math.sin(walk * Math.PI * 2);
  const idle = p.idle ?? 0;

  r.turn.rotation.y = j[TURN] as number;
  r.body.position.y =
    -HIP + (walk === undefined ? Math.sin(idle * Math.PI * 2) * 0.008 : Math.abs(swing) * 0.03);
  r.legL.rotation.x = swing * 0.6;
  r.legR.rotation.x = -swing * 0.6;

  r.armL.rotation.set(j[AL_X] as number, j[AL_Y] as number, j[AL_Z] as number);
  r.armR.rotation.set(j[AR_X] as number, j[AR_Y] as number, j[AR_Z] as number);
  r.upper.rotation.set(j[U_RX] as number, j[U_RY] as number, j[U_RZ] as number);

  // 往後仰：「後」是背對面向的那一邊。跳起來的高度也放這一層（連腳一起離地）
  const face = (j[TURN] as number) >= 0 ? 1 : -1;
  r.lean.rotation.z = -(p.lean ?? 0) * face;
  r.lean.position.y = extra.hop;

  // 莖繞著頭頂擺：待機時輕輕晃，走路時往後甩
  r.sprout.position.y = p.chef ? STEM_BASE + 0.06 : STEM_BASE;
  r.sprout.rotation.z = j[SP_Z] as number;
  r.sprout.rotation.x = j[SP_X] as number;
  const bloom = p.bloom ?? 0;
  r.blooms.forEach((b, i) => {
    b.visible = i === bloom;
  });

  const lid = 1 - extra.blink * 0.9;
  for (const e of r.eyes) e.scale.y = lid;
  r.hat.visible = p.chef === true;
}

/** 每一隻的關節角度（上一幀的），用來平滑 */
const jointMemo = new Map<string, { t: number; v: Float32Array }>();
const target = new Float32Array(JOINTS);

/* ------------------------------------------------------------
   一整個畫面的皮克敏：一個場景、一次算圖
   ------------------------------------------------------------ */

interface Queued {
  x: number;
  y: number;
  h: number;
  team: TeamId;
  pose: Pose3D;
  face: 1 | -1;
}

/** 每一隊最多幾隻。一百個人分四隊，一隊最多也就三四十隻，留寬一點。 */
const MAX_PER_TEAM = 160;

interface Crowd {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  rigs: Record<TeamId, Rig>;
  /** 每一隊、每一個零件一個 InstancedMesh */
  parts: Record<TeamId, THREE.InstancedMesh[]>;
  queue: Queued[];
  w: number;
  h: number;
}

let crowd: Crowd | null | undefined;

function getCrowd(): Crowd | null {
  if (crowd !== undefined) return crowd;
  try {
    crowd = createCrowd();
  } catch (e) {
    console.warn("[p100] 拿不到 WebGL，皮克敏改用 2D 畫法：", e);
    crowd = null;
  }
  return crowd;
}

function createCrowd(): Crowd {
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // ACES 讓亮部柔和收邊，塑膠公仔的質感主要就靠這個
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // 光：跟主視覺一樣的戶外柔光。天光＋左前上方的暖主光＋右後方的冷輪廓光。
  scene.add(new THREE.HemisphereLight(0xdcefff, 0x7a9a55, 0.45));
  const key = new THREE.DirectionalLight(0xfff1dc, 2.0);
  key.position.set(-1.2, 2.2, 2.6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xcfe8ff, 1.8);
  rim.position.set(1.8, 1.4, -2.2);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.3);
  fill.position.set(2, 0.5, 2);
  scene.add(fill);

  const camera = new THREE.OrthographicCamera(0, 1, 0, -1, -20000, 20000);
  camera.position.z = 10000;

  const rigs = {} as Record<TeamId, Rig>;
  const parts = {} as Record<TeamId, THREE.InstancedMesh[]>;
  for (const team of TEAM_IDS) {
    const rig = buildRig(team);
    rigs[team] = rig;
    parts[team] = rig.meshes.map((m) => {
      const inst = new THREE.InstancedMesh(m.geometry, m.material, MAX_PER_TEAM);
      inst.count = 0;
      inst.frustumCulled = false;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(inst);
      return inst;
    });
  }
  return { renderer, scene, camera, rigs, parts, queue: [], w: 0, h: 0 };
}

/** 一個零件看不看得到：它和它所有的上層都要是 visible */
function visibleChain(o: THREE.Object3D, stop: THREE.Object3D): boolean {
  for (let cur: THREE.Object3D | null = o; cur && cur !== stop; cur = cur.parent) {
    if (!cur.visible) return false;
  }
  return true;
}

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * 排一隻皮克敏進這一幀的佇列。(x, y) 是腳底（畫布像素），h 是整隻的高度。
 * @returns false = 沒有 WebGL，呼叫端要自己畫 2D 版。
 */
export function queuePikmin3D(x: number, y: number, h: number, team: TeamId, pose: Pose3D, face: 1 | -1): boolean {
  const c = getCrowd();
  if (!c) return false;
  c.queue.push({ x, y, h, team, pose, face });
  return true;
}

/** 把佇列裡的皮克敏一次算好，貼到 2D 畫布上。 */
export function flushPikmin3D(g: CanvasRenderingContext2D): void {
  const c = crowd;
  if (!c || c.queue.length === 0) return;
  const w = g.canvas.width;
  const h = g.canvas.height;
  if (c.w !== w || c.h !== h) {
    c.renderer.setSize(w, h, false);
    c.camera.left = 0;
    c.camera.right = w;
    c.camera.top = 0;
    c.camera.bottom = -h;
    c.camera.updateProjectionMatrix();
    c.w = w;
    c.h = h;
  }

  const counts: Record<string, number> = {};
  for (const t of TEAM_IDS) counts[t] = 0;

  const seen = new Set<string>();
  let latest = 0;
  for (const q of c.queue) {
    const n = counts[q.team] ?? 0;
    if (n >= MAX_PER_TEAM) continue;
    const rig = c.rigs[q.team];

    // 先算這一幀「應該」擺在哪，再從上一幀的角度轉過去
    const extra = poseTargets(q.pose, q.face, target);
    let joints: ArrayLike<number> = target;
    const time = q.pose.time;
    const id = `${q.team}:${q.pose.key}`;
    // 同一幀出現兩隻同 key 的（呼叫端沒給不同的 phase）就不平滑，免得兩隻互相拉扯
    if (q.pose.key !== undefined && time !== undefined && !seen.has(id)) {
      seen.add(id);
      latest = Math.max(latest, time);
      const memo = jointMemo.get(id);
      if (!memo || time < memo.t || time - memo.t > 500) {
        // 第一次出現、或很久沒出現：直接擺到定位
        jointMemo.set(id, { t: time, v: Float32Array.from(target) });
      } else {
        const a = 1 - Math.exp(-14 * ((time - memo.t) / 1000));
        for (let k = 0; k < JOINTS; k++) {
          memo.v[k] = (memo.v[k] as number) + ((target[k] as number) - (memo.v[k] as number)) * a;
        }
        memo.t = time;
        joints = memo.v;
      }
    }
    applyPose(rig, q.pose, joints, extra);
    // 畫布的 y 往下、3D 的 y 往上；越下面的越靠近鏡頭（z 越大），前後才蓋得對
    rig.root.position.set(q.x, -q.y, q.y);
    rig.root.scale.setScalar(q.h);
    // 稍微往鏡頭傾一點，看得到一點頭頂和腳底的影子
    rig.root.rotation.x = 0.16;
    rig.root.updateMatrixWorld(true);
    const parts = c.parts[q.team];
    rig.meshes.forEach((m, k) => {
      parts[k]?.setMatrixAt(n, visibleChain(m, rig.root) ? m.matrixWorld : HIDDEN);
    });
    counts[q.team] = n + 1;
  }

  for (const t of TEAM_IDS) {
    for (const inst of c.parts[t]) {
      inst.count = counts[t] ?? 0;
      inst.instanceMatrix.needsUpdate = true;
    }
  }
  c.renderer.render(c.scene, c.camera);
  g.drawImage(c.renderer.domElement, 0, 0, w, h);
  c.queue.length = 0;

  // 換關卡之後舊的皮克敏不會再出現，五秒沒看到就丟掉
  if (jointMemo.size > 400) {
    for (const [k, m] of jointMemo) if (latest - m.t > 5000) jointMemo.delete(k);
  }
}
