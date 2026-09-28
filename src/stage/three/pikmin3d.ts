/* ============================================================
   3D 皮克敏

   照主視覺 group.png 建的模型：燈泡形的大頭、亮面的大眼睛、細手細腳，
   頭頂收成一個尖、直接長出一根莖，莖的尾端是葉子或花。
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
import { TEAMS, TEAM_IDS, type TeamId } from "../../shared/teams";
import { blobShadow, toy } from "./studio";

export interface Pose3D {
  /** 走路的相位（一個完整步伐 = 1，連續往上加）。undefined = 站著 */
  walk?: number;
  /** 待機呼吸的相位（連續往上加） */
  idle?: number;
  /** 揮手的相位。undefined = 不揮手 */
  wave?: number;
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

/** 莖從頭頂長出來的位置（沒戴帽子時） */
const STEM_BASE = 0.77;

interface Rig {
  root: THREE.Group; // 放在場景裡的最外層：位置、大小、朝向
  lean: THREE.Group; // 以腳底為軸，在畫面平面上前後仰
  turn: THREE.Group; // 轉成四分之三側面
  body: THREE.Group; // 會上下彈的部分
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  eyes: THREE.Object3D[];
  hat: THREE.Group;
  /** 莖＋葉子／花。支點在頭頂 —— 轉它，根部不會離開頭 */
  sprout: THREE.Group;
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

function buildRig(team: TeamId): Rig {
  const color = BODY[team];
  const skin = toy(color);
  const limbMat = toy(team === "D" ? "#E9ECF2" : new THREE.Color(color).multiplyScalar(0.9).getStyle());
  const dark = toy("#121218", { rough: 0.15, coat: 1 });
  const white = toy("#FFFFFF", { rough: 0.12, coat: 1 });
  const glintMat = toy("#FFFFFF", { rough: 0, coat: 0 });
  const green = toy("#4DB23A", { rough: 0.45, coat: 0.2 });
  const stemMat = toy("#3F8A2C", { rough: 0.5, coat: 0.1 });

  const root = new THREE.Group();
  root.add(blobShadow(0.2));
  const lean = new THREE.Group();
  root.add(lean);
  const turn = new THREE.Group();
  lean.add(turn);
  const body = new THREE.Group();
  turn.add(body);

  // 腳：細細的腿，末端一個小小的腳掌
  const mkLeg = (x: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, 0.165, 0);
    g.add(limb(0.024, 0.11, limbMat));
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 10), limbMat);
    foot.scale.set(0.9, 0.55, 1.4);
    foot.position.set(0, -0.15, 0.012);
    g.add(foot);
    turn.add(g); // 腳不跟身體彈
    return g;
  };
  const legL = mkLeg(-0.042);
  const legR = mkLeg(0.042);

  // 身體：小小的橢圓，上面接一段細脖子
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.075, 32, 20), skin);
  torso.scale.set(1, 1.3, 0.95);
  torso.position.y = 0.245;
  body.add(torso);

  // 手：細手臂＋圓圓的手掌
  const mkArm = (x: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, 0.305, 0);
    g.add(limb(0.019, 0.11, limbMat));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.026, 14, 10), limbMat);
    hand.position.y = -0.145;
    g.add(hand);
    body.add(g);
    return g;
  };
  const armL = mkArm(-0.066);
  const armR = mkArm(0.066);

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

  // 莖＋葉子或花。整組的原點就是頭頂，擺動時繞著頭頂轉。
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

  if (TEAMS[team].sprout === "leaf") {
    // 葉子：一片長橢圓，根部接在莖的尾端
    const leaf = new THREE.Group();
    leaf.position.copy(tip);
    leaf.rotation.set(0.35, 0, 0.3);
    const blade = new THREE.Mesh(new THREE.SphereGeometry(0.1, 28, 16), green);
    blade.scale.set(1, 0.13, 0.48);
    blade.position.x = 0.09; // 葉片的根部剛好在 tip 上
    leaf.add(blade);
    const vein = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.18, 6), stemMat);
    vein.rotation.z = Math.PI / 2;
    vein.position.set(0.09, 0.012, 0);
    leaf.add(vein);
    sprout.add(leaf);
  } else {
    const flower = new THREE.Group();
    flower.position.copy(tip);
    flower.rotation.set(1.1, 0, 0.2); // 朝著鏡頭斜上方開
    const petal = toy("#FFFFFF", { rough: 0.5, coat: 0.2 });
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.042, 16, 10), petal);
      p.scale.set(1, 0.3, 0.55);
      p.position.set(Math.cos(a) * 0.046, 0, Math.sin(a) * 0.046);
      p.rotation.y = -a;
      flower.add(p);
    }
    const center = new THREE.Mesh(new THREE.SphereGeometry(0.024, 16, 12), toy("#FFC21F", { rough: 0.5 }));
    center.position.y = 0.01;
    center.scale.y = 0.6;
    flower.add(center);
    sprout.add(flower);
  }
  body.add(sprout);

  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  return { root, lean, turn, body, legL, legR, armL, armR, eyes, hat, sprout, meshes };
}

/** 把姿勢套到骨架上。所有角度都在這裡，要調手感改這一支。 */
function applyPose(r: Rig, p: Pose3D, face: 1 | -1): void {
  const walk = p.walk;
  const swing = walk === undefined ? 0 : Math.sin(walk * Math.PI * 2);
  const idle = p.idle ?? 0;

  // 朝右或朝左：轉身而不是鏡射（鏡射會把模型翻成裡外相反）
  r.turn.rotation.y = face * 0.32;

  r.body.position.y =
    walk === undefined ? Math.sin(idle * Math.PI * 2) * 0.008 : Math.abs(swing) * 0.03;
  r.legL.rotation.x = swing * 0.6;
  r.legR.rotation.x = -swing * 0.6;

  // 手：預設微微張開往下垂，走路時前後擺
  r.armL.rotation.set(-swing * 0.5, 0, -0.35);
  r.armR.rotation.set(swing * 0.5, 0, 0.35);
  if (p.reach) {
    r.armL.rotation.set(-1.25, 0, -0.15);
    r.armR.rotation.set(-1.25, 0, 0.15);
  }
  if (p.carry) {
    // 兩手舉高過頭，扛著東西
    r.armL.rotation.set(0, 0, -2.75 + swing * 0.08);
    r.armR.rotation.set(0, 0, 2.75 + swing * 0.08);
  }
  if (p.wave !== undefined) {
    r.armR.rotation.set(0, 0, 2.5 + Math.sin(p.wave * Math.PI * 2) * 0.35);
  }

  // 往後仰：「後」是背對面向的那一邊
  r.lean.rotation.z = -(p.lean ?? 0) * face;

  // 莖繞著頭頂擺：待機時輕輕晃，走路時往後甩
  r.sprout.position.y = p.chef ? STEM_BASE + 0.06 : STEM_BASE;
  r.sprout.rotation.z =
    walk === undefined ? Math.sin(idle * Math.PI * 2) * 0.12 : -0.18 + swing * 0.1;
  r.sprout.rotation.x = walk === undefined ? Math.sin(idle * Math.PI * 1.3) * 0.06 : 0;

  const lid = 1 - (p.blink ?? 0) * 0.9;
  for (const e of r.eyes) e.scale.y = lid;
  r.hat.visible = p.chef === true;
}

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

  for (const q of c.queue) {
    const n = counts[q.team] ?? 0;
    if (n >= MAX_PER_TEAM) continue;
    const rig = c.rigs[q.team];
    applyPose(rig, q.pose, q.face);
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
}
