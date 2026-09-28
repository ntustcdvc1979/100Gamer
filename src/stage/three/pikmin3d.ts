/* ============================================================
   3D 皮克敏

   照主視覺 group.png 建的模型：水滴形的大頭、亮面的大眼睛、細手細腳，
   頭頂一根莖接葉子或花。四種的差別也照主視覺：
     紅：尖鼻子、葉子        黃：一對大尖耳、花
     藍：嘴巴、葉子          白：紅眼睛沒有眼白、比較瘦、花

   世界單位：腳底在 y=0，頭頂的葉子／花大約到 y=1。

   ⚠️ 效能：大廳裡可能有一百隻同時在走。每一隻每一幀都拍一次是
   一百次算圖，投影幕那台吃不消。所以小隻的用「拍好的圖」：
   同一隊、同一個姿勢、同一個大小級距只拍一次，之後直接貼。
   走路的腳步切成 8 格、待機切成 4 格，看起來一樣順。
   只有大隻的（大廳卡片上的吉祥物，畫面上同時最多四五隻）才每幀現拍。
   ============================================================ */

import * as THREE from "three";
import { TEAMS, type TeamId } from "../../shared/teams";
import { blobShadow, framing, getStudio, SHOT_PX, toy, type Framing } from "./studio";

export interface Pose3D {
  /** 走路的相位 0..1（一個完整步伐）。undefined = 站著 */
  walk?: number;
  /** 待機呼吸的相位 0..1 */
  idle?: number;
  /** 揮手的相位 0..1。undefined = 不揮手 */
  wave?: number;
  /** 往後仰（拔蘿蔔），弧度，負的是往後 */
  lean?: number;
  /** 兩手往前伸（抓著東西拉） */
  reach?: boolean;
  /** 眨眼 */
  blink?: boolean;
  /** 戴廚師帽 */
  chef?: boolean;
}

/* ------------------------------------------------------------
   模型
   ------------------------------------------------------------ */

/** 3D 裡顏色會被色調映射壓暗一點，底色比 2D 的隊伍色再亮一些。 */
const BODY: Record<TeamId, string> = {
  A: "#E0231A",
  B: "#2F6FEA",
  C: "#FFC928",
  D: "#F6F7FA",
};

interface Rig {
  root: THREE.Group;      // 放在攝影棚裡的最外層（陰影掛這裡，不跟著仰）
  lean: THREE.Group;      // 以腳底為軸，在畫面平面上前後仰
  turn: THREE.Group;      // 轉成四分之三側面
  body: THREE.Group;      // 會上下彈的部分
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  eyes: THREE.Object3D[];
  hat: THREE.Group;
  sprout: THREE.Group;
}

const rigs = new Map<TeamId, Rig>();

function capsule(r: number, len: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 12), mat);
  // 膠囊預設是站直、中心在原點；改成從原點往下垂，關節好轉
  m.position.y = -len / 2 - r * 0.5;
  return m;
}

function headGeometry(team: TeamId): THREE.LatheGeometry {
  // 水滴形：下面圓、上面收成尖，尖端接到莖
  const w = team === "D" ? 0.88 : team === "C" ? 1.06 : 1;
  const pts = [
    // 主視覺的頭比較像顆飽滿的燈泡：最寬的地方在中間，頂端只收一個小尖
    [0, 0.33], [0.09, 0.34], [0.14, 0.375], [0.165, 0.44], [0.168, 0.51],
    [0.155, 0.58], [0.125, 0.64], [0.085, 0.69], [0.04, 0.725], [0.012, 0.745], [0, 0.752],
  ].map(([r, y]) => new THREE.Vector2((r as number) * w, y as number));
  const curve = new THREE.SplineCurve(pts);
  return new THREE.LatheGeometry(curve.getPoints(40), 48);
}

function buildRig(team: TeamId): Rig {
  const color = BODY[team];
  const skin = toy(color);
  const limb = toy(team === "D" ? "#E9ECF2" : new THREE.Color(color).multiplyScalar(0.92).getStyle());
  const dark = toy("#16161C", { rough: 0.2, coat: 1 });
  const white = toy("#FFFFFF", { rough: 0.15, coat: 1 });
  const green = toy("#4DB23A", { rough: 0.45, coat: 0.2 });
  const stemMat = toy("#3F8A2C", { rough: 0.5, coat: 0.1 });

  const root = new THREE.Group();
  root.add(blobShadow(0.2));
  const lean = new THREE.Group();
  root.add(lean);
  const turn = new THREE.Group();
  turn.rotation.y = 0.3; // 微微側一點，臉朝畫面右邊；轉太多眼睛會跑到側面
  lean.add(turn);
  const body = new THREE.Group();
  turn.add(body);

  // 腳
  const mkLeg = (x: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, 0.16, 0);
    g.add(capsule(0.026, 0.1, limb));
    turn.add(g); // 腳不跟身體彈
    return g;
  };
  const legL = mkLeg(-0.042);
  const legR = mkLeg(0.042);

  // 身體
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.075, 32, 20), skin);
  torso.scale.set(1, 1.35, 0.95);
  torso.position.y = 0.245;
  body.add(torso);

  // 手
  const mkArm = (x: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, 0.305, 0);
    g.add(capsule(0.02, 0.11, limb));
    body.add(g);
    return g;
  };
  const armL = mkArm(-0.068);
  const armR = mkArm(0.068);

  // 頭
  const head = new THREE.Mesh(headGeometry(team), skin);
  body.add(head);

  // 眼睛。臉的表面大概在 z = 0.14 左右。
  const eyes: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    // 主視覺的眼睛又大又靠前：兩顆幾乎貼在一起、佔掉半張臉
    eye.position.set(s * 0.058, 0.5, 0.138);
    if (team === "D") {
      // 白皮克敏：一雙紅眼睛，沒有眼白
      const iris = new THREE.Mesh(new THREE.SphereGeometry(0.046, 24, 16), toy("#D61F2B", { rough: 0.12, coat: 1 }));
      iris.scale.z = 0.6;
      eye.add(iris);
    } else {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.055, 24, 16), white);
      ball.scale.z = 0.62;
      eye.add(ball);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.032, 20, 14), dark);
      pupil.position.set(0.008, -0.002, 0.026);
      pupil.scale.z = 0.5;
      eye.add(pupil);
    }
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), toy("#FFFFFF", { rough: 0, coat: 0 }));
    glint.scale.setScalar(1.4);
    glint.position.set(-0.004, 0.016, 0.038);
    eye.add(glint);
    body.add(eye);
    eyes.push(eye);
  }

  if (team === "A") {
    // 紅皮克敏的尖鼻子
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.07, 16), skin);
    nose.rotation.x = Math.PI / 2 + 0.25;
    nose.position.set(0, 0.43, 0.17);
    body.add(nose);
  } else if (team === "B") {
    // 藍皮克敏的嘴巴
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 10), toy("#0E1B45", { rough: 0.3 }));
    mouth.scale.set(1, 0.55, 0.35);
    mouth.position.set(0, 0.415, 0.158);
    body.add(mouth);
  } else if (team === "C") {
    // 黃皮克敏的一對大尖耳
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.22, 20), skin);
      ear.scale.z = 0.35;
      ear.position.set(s * 0.19, 0.56, 0);
      ear.rotation.z = -s * 1.05;
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

  // 莖＋葉子或花
  const sprout = new THREE.Group();
  const stemCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.74, 0),
    new THREE.Vector3(0.012, 0.84, 0),
    new THREE.Vector3(0.045, 0.93, -0.01),
    new THREE.Vector3(0.075, 0.97, -0.015),
  ]);
  sprout.add(new THREE.Mesh(new THREE.TubeGeometry(stemCurve, 16, 0.009, 8), stemMat));
  const tip = new THREE.Vector3(0.075, 0.97, -0.015);

  if (TEAMS[team].sprout === "leaf") {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.1, 28, 16), green);
    leaf.scale.set(1, 0.14, 0.5);
    leaf.position.set(tip.x + 0.07, tip.y + 0.025, tip.z);
    leaf.rotation.set(0.35, 0, 0.35);
    sprout.add(leaf);
    const vein = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.17, 6), stemMat);
    vein.rotation.z = Math.PI / 2 + 0.35;
    vein.position.copy(leaf.position).add(new THREE.Vector3(0, 0.01, 0.01));
    sprout.add(vein);
  } else {
    const flower = new THREE.Group();
    flower.position.copy(tip).add(new THREE.Vector3(0.01, 0.02, 0));
    // 花朝著鏡頭斜上方開
    flower.rotation.set(1.1, 0, 0.2);
    const petal = toy("#FFFFFF", { rough: 0.5, coat: 0.2 });
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 10), petal);
      p.scale.set(1, 0.3, 0.55);
      p.position.set(Math.cos(a) * 0.045, 0, Math.sin(a) * 0.045);
      p.rotation.y = -a;
      flower.add(p);
    }
    const center = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 12), toy("#FFC21F", { rough: 0.5 }));
    center.position.y = 0.01;
    center.scale.y = 0.6;
    flower.add(center);
    sprout.add(flower);
  }
  body.add(sprout);

  return { root, lean, turn, body, legL, legR, armL, armR, eyes, hat, sprout };
}

function rigFor(team: TeamId): Rig {
  let r = rigs.get(team);
  if (!r) {
    r = buildRig(team);
    rigs.set(team, r);
  }
  return r;
}

/** 把姿勢套到骨架上。所有角度都在這裡，要調手感改這一支。 */
function applyPose(r: Rig, p: Pose3D): void {
  const walk = p.walk;
  const swing = walk === undefined ? 0 : Math.sin(walk * Math.PI * 2);
  const idle = p.idle ?? 0;

  r.body.position.y =
    walk === undefined ? Math.sin(idle * Math.PI * 2) * 0.008 : Math.abs(swing) * 0.03;
  r.legL.rotation.x = swing * 0.6;
  r.legR.rotation.x = -swing * 0.6;

  // 手：預設微微張開往下垂
  r.armL.rotation.set(-swing * 0.5, 0, -0.35);
  r.armR.rotation.set(swing * 0.5, 0, 0.35);
  if (p.reach) {
    // 兩手往前伸，像是抓著東西
    r.armL.rotation.set(-1.25, 0, -0.15);
    r.armR.rotation.set(-1.25, 0, 0.15);
  }
  if (p.wave !== undefined) {
    r.armR.rotation.set(0, 0, 2.5 + Math.sin(p.wave * Math.PI * 2) * 0.35);
  }

  r.lean.rotation.z = -(p.lean ?? 0); // 負 lean = 往畫面左後方仰
  // 莖會跟著身體擺，走路時往後甩
  r.sprout.rotation.z = walk === undefined ? Math.sin(idle * Math.PI * 2) * 0.05 : -0.08 + swing * 0.04;
  for (const e of r.eyes) e.scale.y = p.blink ? 0.12 : 1;
  r.hat.visible = p.chef === true;
}

/* ------------------------------------------------------------
   拍照與快取
   ------------------------------------------------------------ */

/** 攝影機框住的範圍：腳底往下一點到頭頂的花往上一點，加上耳朵與後仰的空間。 */
const VIEW_H = 1.45;
let frame: Framing | null = null;
function getFraming(): Framing {
  frame ??= framing(VIEW_H, 0.5);
  return frame;
}

const cache = new Map<string, HTMLCanvasElement>();
/** 這一幀已經新拍了幾張。太多就先用 2D 頂著，下一幀再補 —— 不要一次卡住整個畫面。 */
let shotsThisFrame = 0;
let frameStamp = -1;
const MAX_NEW_PER_FRAME = 10;
/** 快取上限。大約 300 張 256px 的圖，七八十 MB。 */
const MAX_CACHE = 300;

/** 換關卡時清掉，不同關卡用到的姿勢差很多，留著只是佔記憶體。 */
export function clearPikminCache(): void {
  cache.clear();
}

/**
 * 畫一隻 3D 皮克敏。(x, y) 是腳底，h 是整隻（腳底到頭頂的花）的高度。
 * @returns false = 這一幀畫不出來（沒有 WebGL，或新拍的額度用完），呼叫端改畫 2D。
 */
export function drawPikmin3D(
  g: CanvasRenderingContext2D,
  x: number, y: number, h: number,
  team: TeamId,
  pose: Pose3D,
  face: 1 | -1,
  now: number,
): boolean {
  const studio = getStudio();
  if (!studio) return false;
  if (now !== frameStamp) {
    frameStamp = now;
    shotsThisFrame = 0;
  }

  const fr = getFraming();
  // 圖裡「腳底到頭頂」佔 pxPerUnit 像素，要放大到 h
  const scale = h / fr.pxPerUnit;
  const drawSize = SHOT_PX * scale;

  // 大隻的每幀現拍（畫面上同時只有幾隻），小隻的用快取
  const live = drawSize > 300;
  let img: CanvasImageSource;

  if (live) {
    const r = rigFor(team);
    applyPose(r, pose);
    img = studio.shot(r.root, fr.camera);
  } else {
    const px = drawSize > 140 ? 256 : 128;
    const key = poseKey(team, pose, px);
    let c = cache.get(key);
    if (!c) {
      if (shotsThisFrame >= MAX_NEW_PER_FRAME) return false;
      shotsThisFrame++;
      const r = rigFor(team);
      // 拍的是量化過的姿勢 —— 快取的鍵是量化過的，拍的內容也要一致
      applyPose(r, quantizePose(pose));
      const shot = studio.shot(r.root, fr.camera);
      c = document.createElement("canvas");
      c.width = c.height = px;
      const cg = c.getContext("2d") as CanvasRenderingContext2D;
      cg.imageSmoothingQuality = "high";
      cg.drawImage(shot, 0, 0, px, px);
      if (cache.size >= MAX_CACHE) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(key, c);
    }
    img = c;
  }

  const left = x - fr.footX * scale;
  const top = y - fr.footY * scale;
  g.save();
  if (face === -1) {
    // 朝左：以腳底為中心水平翻過來
    g.translate(x, 0);
    g.scale(-1, 1);
    g.translate(-x, 0);
  }
  g.drawImage(img, left, top, drawSize, drawSize);
  g.restore();
  return true;
}

/** 把連續的姿勢切成有限幾格，快取才用得起來。 */
function poseKey(team: TeamId, p: Pose3D, px: number): string {
  const q = (v: number | undefined, n: number): string =>
    v === undefined ? "-" : String(Math.floor((((v % 1) + 1) % 1) * n));
  return [
    team, px,
    q(p.walk, 8),
    p.walk === undefined ? q(p.idle, 4) : "-",
    q(p.wave, 6),
    p.lean === undefined ? "-" : String(Math.round(p.lean / 0.07)),
    p.reach ? "r" : "",
    p.blink ? "b" : "",
    p.chef ? "c" : "",
  ].join("|");
}

/** 快取裡的格子要跟 poseKey 對得上：把連續值先量化，再拍。 */
export function quantizePose(p: Pose3D): Pose3D {
  const snap = (v: number | undefined, n: number): number | undefined =>
    v === undefined ? undefined : Math.floor((((v % 1) + 1) % 1) * n) / n;
  return {
    ...p,
    walk: snap(p.walk, 8),
    idle: p.walk === undefined ? snap(p.idle, 4) : undefined,
    wave: snap(p.wave, 6),
    lean: p.lean === undefined ? undefined : Math.round(p.lean / 0.07) * 0.07,
  };
}
