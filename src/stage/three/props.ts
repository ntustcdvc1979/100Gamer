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

export function panSprite(px: number, food: string, heat: number, lid: number, pepper: boolean): HTMLCanvasElement | null {
  const h = Math.round(heat * 4);
  const l = Math.round(lid * 5);
  return snap(`pan|${px}|${food}|${h}|${l}|${pepper}`, px, () => {
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
    const c = new THREE.Color(food).multiplyScalar(1 - h * 0.06);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.45, 32, 12), toy(c.getStyle(), { rough: 0.5, coat: 0.2 }));
    dish.scale.y = 0.14;
    dish.position.y = 0.15;
    g.add(dish);
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

export { SHOT_PX };
