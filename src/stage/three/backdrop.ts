/* ============================================================
   3D 背景

   主視覺的背景是有景深的 3D 場景：起伏的草坡、石頭、小白花、
   遠方的山和樹，越遠越霧、越糊。這裡用 Three.js 真的蓋一個小場景
   拍下來，再稍微模糊一下當背景 —— 前景的皮克敏是清楚的，
   背景是柔的，立體感就是從這個對比來的（跟主視覺同一招）。

   背景是靜態的，所以每種場景、每種畫面大小只拍一次（大約一兩百毫秒），
   之後每幀只是把那張圖貼上去。會動的雲和光點在 2D 那邊疊上去。

   地平線的高度（horizon）由各關決定：地理達人要的是一大片天空，
   賽跑要的是一大片草地，所以同一個場景會用不同的相機角度拍。
   ============================================================ */

import * as THREE from "three";
import { toy } from "./studio";

export type SceneKind = "meadow" | "kitchen";

const cache = new Map<string, HTMLCanvasElement>();

/** 換畫面大小的時候舊的就用不到了 */
export function clearBackdropCache(): void {
  cache.clear();
}

/**
 * 拍一張背景。拿不到 WebGL 就回傳 null（呼叫端退回 2D 天空草地）。
 * @param horizon 地平線在畫面的哪個高度，0 = 最上面，1 = 最下面
 */
export function backdrop(kind: SceneKind, w: number, h: number, horizon: number): HTMLCanvasElement | null {
  const key = `${kind}|${w}|${h}|${horizon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let out: HTMLCanvasElement;
  try {
    out = render(kind, w, h, horizon);
  } catch (e) {
    console.warn("[p100] 3D 背景拍不出來，改用 2D：", e);
    return null;
  }
  // 一張全螢幕的背景就好幾 MB，最多留三張（通常是目前這一關和前後各一）
  if (cache.size >= 3) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, out);
  return out;
}

function render(kind: SceneKind, w: number, h: number, horizon: number): HTMLCanvasElement {
  // 背景用自己的一台 renderer，拍完就丟 —— 不要去改攝影棚那台的大小
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = kind === "kitchen" ? kitchen() : meadow();
  const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 400);
  if (kind === "kitchen") camera.position.set(0, 1.9, 6.5);
  else camera.position.set(0, 1.4, 8);
  /* 對準地平線：用二分搜尋調相機往哪裡看，讓「參考點」剛好落在畫面的 horizon 高度。
     廚房的參考點是流理台檯面的前緣（皮克敏站的那一條），草地是遠方的地面。
     用算的而不是用眼睛調角度 —— 各關要的高度不一樣，畫面比例也不一樣。 */
  const ref = kind === "kitchen" ? new THREE.Vector3(0, 1.13, 2.6) : new THREE.Vector3(0, 0.6, -90);
  let lo = -30;
  let hi = 30;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    camera.lookAt(0, mid, kind === "kitchen" ? 0 : -12);
    camera.updateMatrixWorld();
    const p = ref.clone().project(camera);
    const screenY = (1 - p.y) / 2;
    // 參考點太高（screenY 太小）就要往上看，它才會往下掉
    if (screenY < horizon) lo = mid;
    else hi = mid;
  }
  renderer.render(scene, camera);

  // 模糊一點點當景深：前景的皮克敏是銳利的，背景是柔的
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const g = out.getContext("2d") as CanvasRenderingContext2D;
  g.filter = `blur(${Math.max(1, Math.round(Math.min(w, h) / 700))}px)`;
  g.drawImage(canvas, 0, 0);
  g.filter = "none";

  renderer.dispose();
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
  return out;
}

/* ------------------------------------------------------------
   小工具：固定種子的亂數，每次拍出來的場景都一樣
   ------------------------------------------------------------ */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** 平滑起伏的地形高度 */
function groundH(x: number, z: number): number {
  return (
    Math.sin(x * 0.18 + 1.3) * 0.5 +
    Math.cos(z * 0.21 + x * 0.07) * 0.45 +
    Math.sin(x * 0.05 - z * 0.04) * 1.2
  ) * Math.min(1, Math.max(0, (-z - 2) / 18)) * 1.2;
}

/* ------------------------------------------------------------
   草地
   ------------------------------------------------------------ */
function meadow(): THREE.Scene {
  const scene = new THREE.Scene();
  const skyTop = new THREE.Color("#3F8DE8");
  const skyLow = new THREE.Color("#CFEFFF");
  scene.fog = new THREE.Fog(skyLow.clone().lerp(new THREE.Color("#E6F7FF"), 0.5), 18, 120);

  // 天空：一顆大球，由上到下的漸層，太陽那一側亮一點
  const skyGeo = new THREE.SphereGeometry(300, 32, 16);
  const colors: number[] = [];
  const pos = skyGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 300;
    const x = pos.getX(i) / 300;
    const t = Math.max(0, Math.min(1, y * 2.2));
    const c = skyLow.clone().lerp(skyTop, t);
    // 右上方的太陽光暈
    const sun = Math.max(0, 1 - Math.hypot(x - 0.45, y - 0.35) * 2.2);
    c.lerp(new THREE.Color("#FFF6DA"), sun * 0.6);
    colors.push(c.r, c.g, c.b);
  }
  skyGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }));
  scene.add(sky);

  // 光：天光＋一顆會投影的太陽
  scene.add(new THREE.HemisphereLight(0xdff1ff, 0x5f8f3a, 1.1));
  const sun = new THREE.DirectionalLight(0xfff0d0, 2.2);
  sun.position.set(20, 30, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  sun.shadow.radius = 4;
  scene.add(sun);

  // 遠山：幾座藍綠色的大圓丘，靠霧把它推遠
  const mountainMat = new THREE.MeshStandardMaterial({ color: "#6FA8C9", roughness: 1 });
  for (const [x, z, r, s] of [[-40, -110, 38, 0.55], [10, -130, 50, 0.5], [55, -105, 34, 0.6], [-5, -95, 26, 0.45]] as const) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16), mountainMat);
    m.scale.y = s;
    m.position.set(x, -2, z);
    scene.add(m);
  }

  // 地面：一大片起伏的草坡，頂點上色做出深淺
  const groundGeo = new THREE.PlaneGeometry(260, 200, 160, 120);
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position as THREE.BufferAttribute;
  const gcol: number[] = [];
  const light = new THREE.Color("#8FD35F");
  const deep = new THREE.Color("#3E9A2F");
  const r1 = rng(11);
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i);
    const z = gp.getZ(i);
    gp.setY(i, groundH(x, z));
    const c = deep.clone().lerp(light, 0.45 + Math.sin(x * 0.3) * 0.15 + Math.cos(z * 0.25) * 0.15 + (r1() - 0.5) * 0.12);
    gcol.push(c.r, c.g, c.b);
  }
  groundGeo.setAttribute("color", new THREE.Float32BufferAttribute(gcol, 3));
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  ground.receiveShadow = true;
  scene.add(ground);

  const r = rng(42);

  // 樹：圓滾滾的樹冠
  const trunkMat = new THREE.MeshStandardMaterial({ color: "#7A5130", roughness: 0.9 });
  const leafMats = ["#4FAE3E", "#5DBB45", "#3F9A35"].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }));
  for (let i = 0; i < 26; i++) {
    const x = (r() - 0.5) * 140;
    const z = -30 - r() * 60;
    if (Math.abs(x) < 8 && z > -40) continue;
    const s = 1.5 + r() * 2.2;
    const y = groundH(x, z);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * s, 0.25 * s, 1.6 * s, 8), trunkMat);
    trunk.position.set(x, y + 0.8 * s, z);
    trunk.castShadow = true;
    scene.add(trunk);
    for (let k = 0; k < 3; k++) {
      const crown = new THREE.Mesh(new THREE.SphereGeometry((1 - k * 0.2) * 1.2 * s, 16, 12), leafMats[(i + k) % 3] as THREE.Material);
      crown.position.set(x + (r() - 0.5) * s, y + (2 + k * 0.7) * s, z + (r() - 0.5) * s);
      crown.castShadow = true;
      scene.add(crown);
    }
  }

  // 石頭：圓圓鈍鈍的灰石頭，前景一些、遠處一些
  const rockMat = new THREE.MeshStandardMaterial({ color: "#8E8A84", roughness: 0.85 });
  for (let i = 0; i < 22; i++) {
    const x = (r() - 0.5) * 60;
    const z = -4 - r() * 35;
    const s = 0.3 + r() * 1.1;
    const geo = new THREE.IcosahedronGeometry(s, 2);
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < p.count; v++) {
      const k = 1 + (Math.sin(p.getX(v) * 5 + i) + Math.cos(p.getZ(v) * 4)) * 0.08;
      p.setXYZ(v, p.getX(v) * k, p.getY(v) * k * 0.7, p.getZ(v) * k);
    }
    geo.computeVertexNormals();
    const rock = new THREE.Mesh(geo, rockMat);
    rock.position.set(x, groundH(x, z) + s * 0.2, z);
    rock.rotation.y = r() * 6;
    rock.castShadow = true;
    rock.receiveShadow = true;
    scene.add(rock);
  }

  // 小白花與草叢：用 InstancedMesh，幾百朵也只要幾次繪製
  const petalGeo = new THREE.SphereGeometry(0.09, 8, 6);
  petalGeo.scale(1, 0.3, 0.6);
  const petals = new THREE.InstancedMesh(petalGeo, toy("#FFFFFF", { rough: 0.6, coat: 0 }), 1500);
  const centers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 8, 6), toy("#FFC21F", { rough: 0.6, coat: 0 }), 300);
  // 草葉：細、淺，不要一根根像刺
  const bladeGeo = new THREE.ConeGeometry(0.025, 0.32, 3);
  const blades = new THREE.InstancedMesh(bladeGeo, new THREE.MeshStandardMaterial({ color: "#5DB343", roughness: 0.8 }), 2400);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  let pi = 0;
  for (let f = 0; f < 300; f++) {
    const x = (r() - 0.5) * 50;
    const z = 4 - r() * 40;
    const y = groundH(x, z) + 0.12;
    centers.setMatrixAt(f, m4.compose(v.set(x, y + 0.02, z), q.identity(), one));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      e.set(0.4, a, 0);
      m4.compose(v.set(x + Math.cos(a) * 0.1, y, z - Math.sin(a) * 0.1), q.setFromEuler(e), one);
      petals.setMatrixAt(pi++, m4);
    }
  }
  for (let b = 0; b < 2400; b++) {
    const x = (r() - 0.5) * 60;
    const z = 1 - r() * 45;
    e.set((r() - 0.5) * 0.5, r() * 6, (r() - 0.5) * 0.5);
    const s = 0.6 + r() * 0.9;
    m4.compose(v.set(x, groundH(x, z) + 0.2 * s, z), q.setFromEuler(e), new THREE.Vector3(s, s, s));
    blades.setMatrixAt(b, m4);
  }
  scene.add(petals, centers, blades);
  return scene;
}

/* ------------------------------------------------------------
   廚房（火候達人）
   ------------------------------------------------------------ */
function kitchen(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#F6DDB2");

  scene.add(new THREE.HemisphereLight(0xfff4e0, 0xb07a45, 1.2));
  const lamp = new THREE.PointLight(0xffd8a0, 60, 30);
  lamp.position.set(0, 5, 3);
  lamp.castShadow = true;
  scene.add(lamp);

  // 牆：一格一格的磁磚貼圖
  const tile = document.createElement("canvas");
  tile.width = tile.height = 128;
  const tg = tile.getContext("2d") as CanvasRenderingContext2D;
  tg.fillStyle = "#FFF4E2";
  tg.fillRect(0, 0, 128, 128);
  tg.strokeStyle = "#E7CFA6";
  tg.lineWidth = 6;
  tg.strokeRect(0, 0, 128, 128);
  const tileTex = new THREE.CanvasTexture(tile);
  tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping;
  tileTex.repeat.set(14, 6);
  tileTex.colorSpace = THREE.SRGBColorSpace;
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(28, 12), new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.6 }));
  wall.position.set(0, 4, -3);
  wall.receiveShadow = true;
  scene.add(wall);

  // 窗戶：外面是亮亮的天空和一點綠
  const frame = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.8, 0.2), new THREE.MeshStandardMaterial({ color: "#B97A45", roughness: 0.7 }));
  frame.position.set(-5.5, 4.4, -2.9);
  scene.add(frame);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(4, 2.4), new THREE.MeshBasicMaterial({ color: "#BFE6FF" }));
  glass.position.set(-5.5, 4.4, -2.78);
  scene.add(glass);
  const bush = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), new THREE.MeshBasicMaterial({ color: "#8CD067" }));
  bush.scale.y = 0.5;
  bush.position.set(-5.3, 3.3, -2.77);
  scene.add(bush);

  // 吊著的鍋鏟和湯勺
  const metal = new THREE.MeshStandardMaterial({ color: "#C9CED6", metalness: 0.8, roughness: 0.3 });
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 5, 8), metal);
  rail.rotation.z = Math.PI / 2;
  rail.position.set(5, 6, -2.8);
  scene.add(rail);
  for (let k = 0; k < 4; k++) {
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 8), metal);
    handle.position.set(3.2 + k * 1.2, 5.3, -2.75);
    scene.add(handle);
    const head = new THREE.Mesh(k % 2 ? new THREE.SphereGeometry(0.25, 12, 8) : new THREE.BoxGeometry(0.4, 0.5, 0.05), metal);
    head.position.set(3.2 + k * 1.2, 4.5, -2.75);
    scene.add(head);
  }

  // 流理台：木頭檯面
  const counter = new THREE.Mesh(new THREE.BoxGeometry(30, 1.6, 4), new THREE.MeshStandardMaterial({ color: "#C98A52", roughness: 0.7 }));
  counter.position.set(0, 0.2, 0.5);
  counter.receiveShadow = true;
  scene.add(counter);
  const top = new THREE.Mesh(new THREE.BoxGeometry(30, 0.15, 4.2), new THREE.MeshStandardMaterial({ color: "#E3A86C", roughness: 0.5 }));
  top.position.set(0, 1.05, 0.5);
  top.receiveShadow = true;
  scene.add(top);

  // 幾個罐子
  const jarMats = ["#F2C94C", "#E86A4A", "#6DBE45"].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.4 }));
  [-9, -7.8, 8.5].forEach((x, i) => {
    const jar = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.9, 20), jarMats[i] as THREE.Material);
    jar.position.set(x, 1.6, -1.5);
    jar.castShadow = true;
    scene.add(jar);
  });
  return scene;
}
