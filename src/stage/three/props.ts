/* ============================================================
   3D 道具：蘿蔔、平底鍋、烤箱、湯碗

   蘿蔔一次會有幾十根在天上飛，所以拍一次就快取起來，轉角度在 2D 做。
   廚房道具一次只有一個、而且狀態會變（菜的熟度、湯剩多少、烤箱亮度），
   量化成幾格之後各拍一次，同樣快取。
   ============================================================ */

import * as THREE from "three";
import { blobShadow, getStudio, SHOT_PX, toy } from "./studio";

const cache = new Map<string, HTMLCanvasElement>();

export function clearPropCache(): void {
  cache.clear();
}

/** 拍一張道具照；key 相同就直接用快取。 */
function snap(key: string, px: number, build: () => { obj: THREE.Object3D; camera: THREE.Camera }): HTMLCanvasElement | null {
  const hit = cache.get(key);
  if (hit) return hit;
  const studio = getStudio();
  if (!studio) return null;
  const { obj, camera } = build();
  const shot = studio.shot(obj, camera);
  const c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.imageSmoothingQuality = "high";
  g.drawImage(shot, 0, 0, px, px);
  cache.set(key, c);
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
  return c;
}

function cam(dist: number, y: number, lookY: number, fov = 26): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(fov, 1, 0.05, 50);
  c.position.set(0, y, dist);
  c.lookAt(0, lookY, 0);
  c.updateMatrixWorld();
  return c;
}

/* ------------------------------------------------------------
   蘿蔔：頭（葉子根部）在圖的正中間偏上，身體往下
   ------------------------------------------------------------ */

/** 蘿蔔圖裡：葉子根部在圖的 (0.5, 0.36)，蘿蔔長度約佔圖高的 0.5 */
export const CARROT_ANCHOR = { x: 0.5, y: 0.36, len: 0.5 };

export function carrotSprite(px: number): HTMLCanvasElement | null {
  return snap(`carrot|${px}`, px, () => {
    const g = new THREE.Group();
    // 身體：旋轉體，上粗下尖，表面一圈一圈的紋路
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const r = 0.16 * Math.pow(1 - t, 0.8) * (1 + Math.sin(t * 40) * 0.025) + 0.004;
      pts.push(new THREE.Vector2(r, -t));
    }
    pts.push(new THREE.Vector2(0, -1));
    const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 32), toy("#F26A0A", { rough: 0.5, coat: 0.25 }));
    g.add(body);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 12), toy("#F26A0A", { rough: 0.5, coat: 0.25 }));
    top.scale.y = 0.35;
    g.add(top);
    // 葉子：三四片長葉子往上散開
    const leaf = toy("#45A935", { rough: 0.55, coat: 0.1 });
    for (const [a, tilt, s] of [[-0.5, -0.35, 1], [0.1, 0.05, 1.15], [0.6, 0.4, 0.95], [2.8, 0.2, 0.85]] as const) {
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), leaf);
      l.scale.set(1, 5.5 * s, 0.4);
      l.position.set(Math.sin(tilt) * 0.2 * s, 0.25 * s, Math.cos(a) * 0.03);
      l.rotation.set(0, a, -tilt);
      g.add(l);
    }
    g.rotation.y = 0.4;
    return { obj: g, camera: cam(3.2, 0, -0.17) };
  });
}

/* ------------------------------------------------------------
   平底鍋：鍋身＋鍋柄＋裡面的菜
   ------------------------------------------------------------ */

/** 平底鍋。empty = 不放菜（菜被拋到空中的時候，菜另外用 foodSprite 畫） */
export function panSprite(px: number, food: string, heat: number, lid: number, pepper: boolean, empty = false): HTMLCanvasElement | null {
  const h = Math.round(heat * 4);
  const l = Math.round(lid * 5);
  return snap(`pan|${px}|${food}|${h}|${l}|${pepper}|${empty}`, px, () => {
    const g = new THREE.Group();
    g.add(blobShadow(0.9, 0.3));
    const iron = new THREE.MeshPhysicalMaterial({ color: "#2A2A30", roughness: 0.35, metalness: 0.6, clearcoat: 0.4 });
    // 鍋身：一個淺淺的碗
    const prof = [
      new THREE.Vector2(0, 0.08), new THREE.Vector2(0.6, 0.08), new THREE.Vector2(0.68, 0.12),
      new THREE.Vector2(0.72, 0.25), new THREE.Vector2(0.68, 0.25), new THREE.Vector2(0.64, 0.14),
      new THREE.Vector2(0.58, 0.12), new THREE.Vector2(0, 0.12),
    ];
    g.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 48), iron));
    // 鍋柄
    const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.8, 6, 12), toy("#4A2E1A", { rough: 0.6, coat: 0.2 }));
    handle.rotation.z = Math.PI / 2 + 0.1;
    handle.position.set(1.15, 0.22, 0);
    g.add(handle);
    // 菜：顏色隨熱度變深
    if (!empty) {
      const c = new THREE.Color(food).multiplyScalar(1 - h * 0.06);
      const dish = new THREE.Mesh(new THREE.SphereGeometry(0.45, 32, 12), toy(c.getStyle(), { rough: 0.5, coat: 0.2 }));
      dish.scale.y = 0.14;
      dish.position.y = 0.15;
      g.add(dish);
    }
    if (pepper) {
      const dot = toy("#1E1E1E", { rough: 0.8, coat: 0 });
      for (let k = 0; k < 24; k++) {
        const d = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 4), dot);
        const a = k * 2.4;
        const rr = 0.08 + (k / 24) * 0.33;
        d.position.set(Math.cos(a) * rr, 0.21, Math.sin(a) * rr);
        g.add(d);
      }
    }
    if (l > 0) {
      // 鍋蓋：越多人掀了就抬得越高
      const lidMesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.66, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshPhysicalMaterial({ color: "#D5DAE2", roughness: 0.25, metalness: 0.7 }),
      );
      lidMesh.scale.y = 0.35;
      lidMesh.position.y = 0.25 + (l - 1) * 0.12;
      g.add(lidMesh);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), toy("#4A2E1A"));
      knob.position.y = lidMesh.position.y + 0.25;
      g.add(knob);
    }
    g.rotation.y = -0.15;
    return { obj: g, camera: cam(3.6, 1.9, 0.15) };
  });
}

/* ------------------------------------------------------------
   做動作動畫用的小零件：拋到空中的菜、胡椒罐、飛起來的高麗菜葉
   ------------------------------------------------------------ */

/** 平底鍋的相機。菜用同一個角度拍，疊回鍋子上才對得齊（菜的中心就在圖的正中間） */
const PAN_CAM = (): THREE.PerspectiveCamera => cam(3.6, 1.9, 0.15);

/**
 * 單獨一塊菜，角度跟 panSprite 一樣。
 * seared = 煎過的那一面（翻過來時看到的），顏色深一點、有焦痕。
 */
export function foodSprite(px: number, kind: "egg" | "ham", seared: boolean): HTMLCanvasElement | null {
  return snap(`food|${px}|${kind}|${seared}`, px, () => {
    const g = new THREE.Group();
    if (kind === "egg") {
      const egg = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 32, 12),
        toy(seared ? "#D9901C" : "#F2B21C", { rough: 0.5, coat: 0.2 }),
      );
      egg.scale.y = 0.12;
      g.add(egg);
      // 蛋餅皮上的蔥花
      const r = rng(5);
      const scallion = toy("#4FA83A", { rough: 0.5 });
      for (let k = 0; k < 14; k++) {
        const d = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), scallion);
        const a = r() * Math.PI * 2;
        const rr = Math.sqrt(r()) * 0.3;
        d.scale.y = 0.4;
        d.position.set(Math.cos(a) * rr, 0.05, Math.sin(a) * rr);
        g.add(d);
      }
    } else {
      // 素火腿：一片圓角長方形的粉紅色厚片，煎過的那面有烤痕
      const shape = new THREE.Shape();
      const W = 0.34, D = 0.24, R = 0.07;
      shape.moveTo(-W + R, -D);
      shape.lineTo(W - R, -D); shape.quadraticCurveTo(W, -D, W, -D + R);
      shape.lineTo(W, D - R); shape.quadraticCurveTo(W, D, W - R, D);
      shape.lineTo(-W + R, D); shape.quadraticCurveTo(-W, D, -W, D - R);
      shape.lineTo(-W, -D + R); shape.quadraticCurveTo(-W, -D, -W + R, -D);
      const slab = new THREE.Mesh(
        new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.012, bevelSegments: 3 }),
        toy(seared ? "#B8444C" : "#E8606F", { rough: 0.45, coat: 0.35 }),
      );
      slab.rotation.x = -Math.PI / 2;
      slab.position.y = -0.015;
      g.add(slab);
      if (seared) {
        const mark = toy("#7A2A2A", { rough: 0.6 });
        for (let k = -2; k <= 2; k++) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.01, 0.4), mark);
          m.position.set(k * 0.12, 0.035, 0);
          m.rotation.y = 0.5;
          g.add(m);
        }
      }
    }
    g.position.y = 0.15;
    g.rotation.y = -0.15;
    return { obj: g, camera: PAN_CAM() };
  });
}

/** 胡椒罐：玻璃罐身裡看得到黑胡椒，上面一個有洞的銀色圓蓋。蓋子朝上，旋轉在 2D 做。 */
export function shakerSprite(px: number): HTMLCanvasElement | null {
  return snap(`shaker|${px}`, px, () => {
    const g = new THREE.Group();
    const glass = new THREE.MeshPhysicalMaterial({ color: "#E8F2FF", roughness: 0.05, transmission: 0.6, transparent: true, opacity: 0.55, clearcoat: 1 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.8, 32), glass);
    body.position.y = 0.4;
    g.add(body);
    const pepper = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.27, 0.55, 32), toy("#2B2622", { rough: 0.9 }));
    pepper.position.y = 0.3;
    g.add(pepper);
    const metal = new THREE.MeshPhysicalMaterial({ color: "#D9DDE3", metalness: 0.9, roughness: 0.2 });
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.3, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), metal);
    cap.scale.y = 0.6;
    cap.position.y = 0.8;
    g.add(cap);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.305, 0.305, 0.08, 32), metal);
    ring.position.y = 0.8;
    g.add(ring);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const hole = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), toy("#222226"));
      hole.position.set(Math.cos(a) * 0.12, 0.96, Math.sin(a) * 0.12);
      g.add(hole);
    }
    return { obj: g, camera: cam(3.2, 0.9, 0.5) };
  });
}

/** 一片胡蘿蔔：橘色圓片，中間一圈比較淡的芯，邊緣有一點點厚度 */
function carrotSlice(): THREE.Group {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.016, 24), toy("#F2701A", { rough: 0.4, coat: 0.5 }));
  g.add(disc);
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.018, 18), toy("#F9A24C", { rough: 0.45, coat: 0.4 }));
  g.add(core);
  return g;
}

/** 單獨一片胡蘿蔔（炒的時候跟著高麗菜一起飛起來） */
export function carrotSliceSprite(px: number): HTMLCanvasElement | null {
  return snap(`carrotslice|${px}`, px, () => {
    const g = new THREE.Group();
    const m = carrotSlice();
    m.scale.setScalar(5);
    m.rotation.set(0.9, 0, 0.2);
    g.add(m);
    return { obj: g, camera: cam(3, 0.4, 0) };
  });
}

/** 一片高麗菜葉（炒的時候拋到空中那種），第 i 種形狀 */
export function cabbageBitSprite(px: number, i: number): HTMLCanvasElement | null {
  return snap(`cabbit|${px}|${i}`, px, () => {
    const g = new THREE.Group();
    const r = rng(100 + i * 13);
    const leafM = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.4, clearcoat: 0.6, side: THREE.DoubleSide });
    const leaf = new THREE.Mesh(cabbageLeaf(r, 0.5, new THREE.Color("#8FCB4A").offsetHSL(0, 0, (r() - 0.5) * 0.1)), leafM);
    leaf.rotation.set(-0.35, 0.25, r() * 3);
    g.add(leaf);
    return { obj: g, camera: cam(3, 0.4, 0) };
  });
}

/** 固定種子的亂數：同一個 key 每次拍出來都長一樣，量化切格的時候才不會跳 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------
   炸薯條：速食店那種不鏽鋼油炸機，金黃色的油，
   鐵絲籃子掛著長柄，越多人「起鍋」籃子就從油裡撈得越高
   ------------------------------------------------------------ */

export function fryerSprite(px: number, lift: number, heat: number): HTMLCanvasElement | null {
  const l = Math.round(lift * 5);
  const h = Math.round(heat * 3);
  return snap(`fryer|${px}|${l}|${h}`, px, () => {
    const g = new THREE.Group();
    g.add(blobShadow(1.0, 0.3));
    const steel = new THREE.MeshPhysicalMaterial({ color: "#C9CED6", roughness: 0.28, metalness: 0.85, clearcoat: 0.3 });
    const W = 1.5, D = 0.95, H = 0.8, T = 0.05;
    // 油槽：四面牆＋底，中間是空的才裝得下油
    const walls: [number, number, number, number, number, number][] = [
      [W, H, T, 0, H / 2, D / 2], [W, H, T, 0, H / 2, -D / 2],
      [T, H, D, W / 2, H / 2, 0], [T, H, D, -W / 2, H / 2, 0],
      [W, T, D, 0, T / 2, 0],
    ];
    for (const [bw, bh, bd, x, y, z] of walls) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), steel);
      m.position.set(x, y, z);
      g.add(m);
    }
    // 上緣一圈捲邊
    for (const [lw, ld, x, z] of [[W + 0.08, 0.09, 0, D / 2], [W + 0.08, 0.09, 0, -D / 2], [0.09, D, W / 2, 0], [0.09, D, -W / 2, 0]] as const) {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(lw, 0.05, ld), steel);
      lip.position.set(x, H, z);
      g.add(lip);
    }
    // 前面的控制面板：黑色一條、一顆紅燈一顆綠燈
    const panel = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.16, 0.02), toy("#23262D", { rough: 0.4 }));
    panel.position.set(0, 0.2, D / 2 + 0.03);
    g.add(panel);
    for (const [x, c] of [[-0.5, "#FF4A3A"], [-0.38, "#3DDC6A"]] as const) {
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), new THREE.MeshBasicMaterial({ color: c }));
      led.position.set(x, 0.2, D / 2 + 0.05);
      g.add(led);
    }

    // 油：金黃、亮亮的
    const oilY = H - 0.14;
    const oil = new THREE.Mesh(
      new THREE.PlaneGeometry(W - T * 2, D - T * 2),
      new THREE.MeshPhysicalMaterial({ color: "#D98A12", roughness: 0.12, clearcoat: 1, metalness: 0.1 }),
    );
    oil.rotation.x = -Math.PI / 2;
    oil.position.y = oilY;
    g.add(oil);
    // 油面冒的泡泡（籃子還在油裡的時候比較多）
    const bubbleM = new THREE.MeshPhysicalMaterial({ color: "#FFD27A", roughness: 0.1, clearcoat: 1, transparent: true, opacity: 0.85 });
    const rb = rng(7);
    const bubbles = l >= 5 ? 6 : 22;
    for (let k = 0; k < bubbles; k++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.018 + rb() * 0.03, 10, 6), bubbleM);
      b.scale.y = 0.5;
      b.position.set((rb() - 0.5) * (W - 0.2), oilY, (rb() - 0.5) * (D - 0.2));
      g.add(b);
    }

    // 鐵絲籃：沿著邊一根一根的細鐵條
    const basket = new THREE.Group();
    const wire = new THREE.MeshPhysicalMaterial({ color: "#E4E7EC", roughness: 0.3, metalness: 0.9 });
    const bw = 0.95, bh = 0.42, bd = 0.62;
    const bar = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r = 0.008): void => {
      const a = new THREE.Vector3(x0, y0, z0);
      const b = new THREE.Vector3(x1, y1, z1);
      const len = a.distanceTo(b);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), wire);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      basket.add(m);
    };
    const X = bw / 2, Z = bd / 2;
    // 上下兩圈框
    for (const y of [0, bh]) {
      const r = y === bh ? 0.016 : 0.01;
      bar(-X, y, -Z, X, y, -Z, r); bar(-X, y, Z, X, y, Z, r);
      bar(-X, y, -Z, -X, y, Z, r); bar(X, y, -Z, X, y, Z, r);
    }
    // 直的鐵條
    for (let k = 0; k <= 12; k++) {
      const x = -X + (k / 12) * bw;
      bar(x, 0, Z, x, bh, Z); bar(x, 0, -Z, x, bh, -Z); bar(x, 0, -Z, x, 0, Z);
    }
    for (let k = 1; k < 8; k++) {
      const z = -Z + (k / 8) * bd;
      bar(-X, 0, z, -X, bh, z); bar(X, 0, z, X, bh, z); bar(-X, 0, z, X, 0, z);
    }
    // 薯條：細長條，堆得滿滿、冒出籃子一點
    const fry = rng(11);
    const golden = new THREE.Color("#F5B82E").lerp(new THREE.Color("#D98E1F"), h * 0.2);
    for (let k = 0; k < 70; k++) {
      const len = 0.22 + fry() * 0.2;
      const f = new THREE.Mesh(
        new THREE.BoxGeometry(0.045, 0.045, len),
        toy(golden.clone().multiplyScalar(0.9 + fry() * 0.2).getStyle(), { rough: 0.55, coat: 0.3 }),
      );
      f.position.set((fry() - 0.5) * (bw - 0.1), 0.04 + fry() * (bh + 0.06), (fry() - 0.5) * (bd - 0.12));
      f.rotation.set((fry() - 0.5) * 1.4, fry() * Math.PI, (fry() - 0.5) * 0.8);
      basket.add(f);
    }
    // 長柄：從籃子前緣往前上方伸出來，黑色握把
    bar(0, bh, Z, 0, bh + 0.28, Z + 0.45, 0.02);
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.3, 6, 12), toy("#1F1F24", { rough: 0.5, coat: 0.3 }));
    grip.position.set(0, bh + 0.4, Z + 0.66);
    grip.rotation.x = Math.PI / 2 - 0.55;
    basket.add(grip);

    // 籃子：沒人起鍋時整籃泡在油裡，全場都起鍋了就整籃撈出來
    basket.position.y = oilY - bh + 0.08 + (l / 5) * 0.62;
    basket.position.z = -0.05;
    g.add(basket);

    g.rotation.y = -0.18;
    return { obj: g, camera: cam(5.0, 2.8, 0.7) };
  });
}

/* ------------------------------------------------------------
   炒高麗菜：炒鍋裡一片一片皺皺的高麗菜葉，白色的葉脈，
   再丟幾片蒜片、辣椒圈 —— 台灣快炒店的樣子
   ------------------------------------------------------------ */

/** 一片撕下來的高麗菜：邊緣不規則、中間拱起來、表面有皺摺，靠中間那條是白色的葉脈 */
function cabbageLeaf(r: () => number, size: number, green: THREE.Color): THREE.BufferGeometry {
  const geo = new THREE.RingGeometry(0.001, 1, 28, 6);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors: number[] = [];
  const p1 = r() * 6, p2 = r() * 6, p3 = r() * 6;
  const rib = new THREE.Color("#F2F7DE");
  const ribAngle = r() * 0.6 - 0.3;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const a = Math.atan2(y, x);
    const rad = Math.hypot(x, y);
    // 不規則的外形：大波浪＋小鋸齒
    const R = 1 + 0.2 * Math.sin(3 * a + p1) + 0.1 * Math.sin(7 * a + p2) + 0.05 * Math.sin(13 * a + p3);
    const px2 = Math.cos(a) * rad * R * size;
    const py2 = Math.sin(a) * rad * R * size * 0.8;
    // 拱起來（像湯匙）＋邊緣波浪皺摺
    const z = -0.32 * rad * rad * size + 0.07 * size * rad * Math.sin(9 * a + p2) + 0.03 * size * Math.sin(px2 * 30) * rad;
    pos.setXYZ(i, px2, py2, z);
    // 葉脈：一條斜斜穿過中間的白色粗筋，旁邊再淡淡的幾條細筋
    const d = Math.abs(Math.sin(ribAngle) * px2 - Math.cos(ribAngle) * py2) / size;
    const vein = Math.exp(-((d / 0.1) ** 2)) + 0.2 * Math.exp(-(((Math.abs(Math.sin(a * 3 + p3)) * rad) / 0.08) ** 2));
    const c = green.clone().lerp(rib, Math.min(1, vein * 0.95 + (1 - rad) * 0.15));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

export function wokSprite(px: number, heat: number): HTMLCanvasElement | null {
  const h = Math.round(heat * 3);
  return snap(`wok|${px}|${h}`, px, () => {
    const g = new THREE.Group();
    g.add(blobShadow(0.95, 0.3));
    const iron = new THREE.MeshPhysicalMaterial({ color: "#26262B", roughness: 0.3, metalness: 0.65, clearcoat: 0.5, side: THREE.DoubleSide });
    // 炒鍋：比平底鍋深的圓底鍋
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI * 0.36;
      prof.push(new THREE.Vector2(Math.sin(a) * 0.82, 0.06 + (1 - Math.cos(a)) * 0.82));
    }
    g.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 56), iron));
    const rim = new THREE.Mesh(new THREE.TorusGeometry(prof[20]!.x, 0.022, 8, 64), iron);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = prof[20]!.y;
    g.add(rim);
    // 長木柄＋對面一個小耳朵
    const wood = toy("#6B4122", { rough: 0.6, coat: 0.2 });
    const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.7, 6, 12), wood);
    handle.rotation.z = Math.PI / 2 + 0.28;
    handle.position.set(1.1, 0.58, 0);
    g.add(handle);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.25, 10), iron);
    stem.rotation.z = Math.PI / 2 + 0.28;
    stem.position.set(0.78, 0.49, 0);
    g.add(stem);
    const ear = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.02, 8, 20, Math.PI), iron);
    ear.position.set(-0.76, 0.48, 0);
    ear.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    g.add(ear);

    // 高麗菜：熱度越高顏色越深、越透（炒軟了）
    const r = rng(23);
    const leafM = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.3, side: THREE.DoubleSide });
    const base = new THREE.Color("#8FCB4A").lerp(new THREE.Color("#6FA832"), h * 0.25);
    /** 離中心 rr 的地方，菜堆的表面有多高：貼著鍋壁往上，中間再堆成一座小山 */
    const heap = (rr: number): number => {
      // 葉子半徑大約 0.3，外緣不能穿出鍋壁：用「葉子外緣那一點」的鍋壁高度當下限
      const wall = 0.88 - Math.sqrt(Math.max(0, 0.82 ** 2 - Math.min(0.72, rr + 0.3) ** 2)) + 0.02;
      return Math.max(wall, 0.2 + (1 - (rr / 0.62) ** 2) * 0.28);
    };
    for (let k = 0; k < 44; k++) {
      const green = base.clone().offsetHSL((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.1);
      const leaf = new THREE.Mesh(cabbageLeaf(r, 0.13 + r() * 0.09, green), leafM);
      const rr = Math.sqrt(r()) * 0.4;
      const a = r() * Math.PI * 2;
      leaf.position.set(Math.cos(a) * rr, heap(rr) - r() * 0.05, Math.sin(a) * rr);
      leaf.rotation.set(-Math.PI / 2 + (r() - 0.5) * 0.6, (r() - 0.5) * 0.6, r() * Math.PI * 2);
      g.add(leaf);
    }
    // 蒜片（白）與辣椒圈（紅）
    const garlic = toy("#F7EFD8", { rough: 0.5, coat: 0.3 });
    const chili = toy("#E0281C", { rough: 0.35, coat: 0.6 });
    for (let k = 0; k < 12; k++) {
      const rr = Math.sqrt(r()) * 0.45;
      const a = r() * Math.PI * 2;
      const y = heap(rr) + 0.04;
      const m = k % 3 === 0
        ? new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.01, 6, 14), chili)
        : new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.012, 12), garlic);
      m.position.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
      m.rotation.set(Math.PI / 2 + (r() - 0.5) * 0.8, 0, r() * 3);
      g.add(m);
    }
    // 胡蘿蔔片：大部分平躺在菜上，幾片斜插在葉子之間
    for (let k = 0; k < 11; k++) {
      const rr = Math.sqrt(r()) * 0.46;
      const a = r() * Math.PI * 2;
      const m = carrotSlice();
      m.position.set(Math.cos(a) * rr, heap(rr) + 0.02, Math.sin(a) * rr);
      m.rotation.set((r() - 0.5) * 0.9, r() * 3, (r() - 0.5) * 0.9);
      g.add(m);
    }
    g.rotation.y = -0.15;
    return { obj: g, camera: cam(3.3, 2.5, 0.2) };
  });
}

/* ------------------------------------------------------------
   烤箱：玻璃窗的亮度＝已經開燈的人的比例
   ------------------------------------------------------------ */

export function ovenSprite(px: number, glow: number): HTMLCanvasElement | null {
  const q = Math.round(glow * 5);
  return snap(`oven|${px}|${q}`, px, () => {
    const g = new THREE.Group();
    g.add(blobShadow(1.1, 0.3));
    const shell = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.15, 1.1), toy("#E9EDF3", { rough: 0.3, coat: 0.6 }));
    shell.position.y = 0.6;
    g.add(shell);
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.72, 0.04), toy("#3A404C", { rough: 0.3 }));
    door.position.set(-0.1, 0.62, 0.56);
    g.add(door);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(1.0, 0.52),
      new THREE.MeshBasicMaterial({ color: new THREE.Color("#3A2410").lerp(new THREE.Color("#FFD27A"), 0.15 + (q / 5) * 0.85) }),
    );
    glass.position.set(-0.1, 0.62, 0.585);
    g.add(glass);
    // 焗烤盤
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 0.3), toy(new THREE.Color("#F2C94C").multiplyScalar(0.7 + q * 0.06).getStyle()));
    tray.position.set(-0.1, 0.45, 0.5);
    g.add(tray);
    // 把手與旋鈕
    const metal = new THREE.MeshPhysicalMaterial({ color: "#B8BEC8", metalness: 0.8, roughness: 0.25 });
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 12), metal);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(-0.1, 1.02, 0.62);
    g.add(bar);
    for (const y of [0.85, 0.6, 0.35]) {
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 16), metal);
      knob.rotation.x = Math.PI / 2;
      knob.position.set(0.63, y, 0.57);
      g.add(knob);
    }
    g.rotation.y = -0.2;
    // 相機拉遠一點：烤箱比鍋子方正，太近的話邊角會超出畫框被切掉
    return { obj: g, camera: cam(5.6, 1.6, 0.5) };
  });
}

/* ------------------------------------------------------------
   湯碗：湯面高度＝全場平均還剩多少
   ------------------------------------------------------------ */

export function bowlSprite(px: number, level: number): HTMLCanvasElement | null {
  const q = Math.round(level * 10);
  return snap(`bowl|${px}|${q}`, px, () => {
    const g = new THREE.Group();
    g.add(blobShadow(0.9, 0.3));
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI * 0.5;
      prof.push(new THREE.Vector2(0.15 + Math.sin(a) * 0.6, 0.05 + (1 - Math.cos(a)) * 0.55));
    }
    const inner = prof.slice().reverse().map((p) => new THREE.Vector2(p.x - 0.05, p.y + 0.02));
    const bowl = new THREE.Mesh(
      new THREE.LatheGeometry([new THREE.Vector2(0, 0.05), ...prof, ...inner, new THREE.Vector2(0, 0.1)], 48),
      toy("#FFFFFF", { rough: 0.2, coat: 0.8 }),
    );
    g.add(bowl);
    // 碗口一圈藍色花紋
    const rimBand = new THREE.Mesh(new THREE.TorusGeometry(0.73, 0.025, 8, 64), toy("#2D6CDF", { rough: 0.3 }));
    rimBand.rotation.x = Math.PI / 2;
    rimBand.position.y = 0.52;
    g.add(rimBand);
    if (q > 0) {
      const y = 0.12 + (q / 10) * 0.4;
      const r = 0.15 + Math.sin(Math.acos(1 - (y - 0.05) / 0.55)) * 0.55;
      const soup = new THREE.Mesh(new THREE.CircleGeometry(r, 48), toy("#D2690F", { rough: 0.25, coat: 0.6 }));
      soup.rotation.x = -Math.PI / 2;
      soup.position.y = y;
      g.add(soup);
    }
    return { obj: g, camera: cam(3.3, 1.9, 0.25) };
  });
}

/* ------------------------------------------------------------
   廚房小屋（熱血賽跑的終點）：大家扛著剛拔的蘿蔔跑回來
   圖裡：屋子底部的正中間在 (0.5, 0.86)，屋子寬約佔圖寬的 0.62
   ------------------------------------------------------------ */

export const COTTAGE_ANCHOR = { x: 0.5, y: 0.86, width: 0.62, smokeX: 0.3, smokeY: 1.05 };

export function cottageSprite(px: number): HTMLCanvasElement | null {
  return snap(`cottage|${px}`, px, () => {
    const g = new THREE.Group();
    g.add(blobShadow(1.3, 0.35));
    const wall = toy("#FFF1D6", { rough: 0.7, coat: 0.1 });
    const roof = toy("#D9573B", { rough: 0.45, coat: 0.4 });
    const woodM = toy("#8A5428", { rough: 0.6, coat: 0.2 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.95, 1.1), wall);
    body.position.y = 0.475;
    g.add(body);

    // 屋頂：兩片斜板，前後各一片山牆
    for (const s of [-1, 1]) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.08, 1.3), roof);
      slab.position.set(s * 0.37, 1.18, 0);
      slab.rotation.z = -s * 0.62;
      g.add(slab);
    }
    const gableShape = new THREE.Shape();
    gableShape.moveTo(-0.75, 0);
    gableShape.lineTo(0.75, 0);
    gableShape.lineTo(0, 0.5);
    gableShape.closePath();
    const gable = new THREE.Mesh(new THREE.ExtrudeGeometry(gableShape, { depth: 1.08, bevelEnabled: false }), wall);
    gable.position.set(0, 0.95, -0.54);
    g.add(gable);

    // 煙囪
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.4, 0.18), toy("#B8543A", { rough: 0.6 }));
    chimney.position.set(0.42, 1.35, -0.2);
    g.add(chimney);

    // 門與門框
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.56, 0.04), woodM);
    door.position.set(-0.25, 0.28, 0.56);
    g.add(door);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 8), toy("#F2C94C", { rough: 0.2, coat: 1 }));
    knob.position.set(-0.14, 0.28, 0.59);
    g.add(knob);

    // 窗戶：裡面亮著暖暖的燈
    const glow = new THREE.MeshBasicMaterial({ color: "#FFD27A" });
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.28), glow);
    win.position.set(0.33, 0.55, 0.556);
    g.add(win);
    const frameM = toy("#FFFFFF", { rough: 0.5 });
    for (const [w, h, x, y] of [[0.4, 0.04, 0.33, 0.7], [0.4, 0.04, 0.33, 0.4], [0.04, 0.3, 0.13, 0.55], [0.04, 0.3, 0.53, 0.55], [0.03, 0.28, 0.33, 0.55]] as const) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.03), frameM);
      f.position.set(x, y, 0.57);
      g.add(f);
    }
    // 門口的遮雨棚
    const awning = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.22), roof);
    awning.position.set(-0.25, 0.62, 0.64);
    awning.rotation.x = 0.35;
    g.add(awning);

    g.rotation.y = -0.45; // 門朝著跑過來的方向（左邊）
    return { obj: g, camera: cam(5.4, 1.6, 0.75) };
  });
}

export { SHOT_PX };
