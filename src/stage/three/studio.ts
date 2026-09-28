/* ============================================================
   3D 攝影棚

   主視覺 group.png 是 3D 算圖的公仔風格：亮面塑膠質感、柔和的主光、
   背後一圈輪廓光、腳底一團軟陰影。2D 平塗怎麼畫都不像，所以角色和
   道具改用 Three.js 真的建模、打光，再「拍」成圖貼到投影幕的 2D 畫布上。

   為什麼不把整個投影幕換成 Three.js 場景：
     文字、地圖、計分表這些東西用 2D 畫最清楚也最好排版；
     真正需要立體感的只有角色和道具。所以 3D 只負責「拍照」，
     版面還是原本那套 2D —— 每一關的版面邏輯一行都不用動。

   一台 512×512 的離屏 WebGL 畫布，全投影幕共用。
   拍一張的成本大約零點幾毫秒，而且拍過的會快取（見 pikmin3d.ts）。

   ⚠️ 拿不到 WebGL（很舊的筆電、顯卡驅動壞掉）就回傳 null，
   呼叫端要退回 2D 畫法 —— 畫面變樸素，但遊戲照樣跑。
   ============================================================ */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export const SHOT_PX = 512;

export interface Studio {
  readonly renderer: THREE.WebGLRenderer;
  /** 把 object 放進攝影棚拍一張，回傳那張 512×512 的畫布（下一次拍照就會被蓋掉，要馬上用）。 */
  shot(object: THREE.Object3D, camera: THREE.Camera): HTMLCanvasElement;
  /** 環境反射貼圖，材質要亮面反光時用 */
  readonly envMap: THREE.Texture;
}

let studio: Studio | null | undefined;

export function getStudio(): Studio | null {
  if (studio !== undefined) return studio;
  try {
    studio = createStudio();
  } catch (e) {
    console.warn("[p100] 拿不到 WebGL，皮克敏改用 2D 畫法：", e);
    studio = null;
  }
  return studio;
}

function createStudio(): Studio {
  const canvas = document.createElement("canvas");
  canvas.width = SHOT_PX;
  canvas.height = SHOT_PX;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    // 拍完要馬上 drawImage 到 2D 畫布上。沒有這個的話，某些瀏覽器在
    // 同一幀裡拍第二張時會把第一張清掉。
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
  });
  renderer.setSize(SHOT_PX, SHOT_PX, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // ACES 讓亮部柔和收邊，塑膠公仔的質感主要就靠這個
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const scene = new THREE.Scene();
  scene.environment = envMap;

  // 天光／地面反光：上面偏藍、下面偏草綠，跟主視覺的戶外光一致
  scene.add(new THREE.HemisphereLight(0xdcefff, 0x7a9a55, 0.45));
  // 主光：左前上方的暖光
  const key = new THREE.DirectionalLight(0xfff1dc, 2.0);
  key.position.set(-1.2, 2.2, 2.6);
  scene.add(key);
  // 輪廓光：右後方的冷光，讓角色的邊從背景裡跳出來
  const rim = new THREE.DirectionalLight(0xcfe8ff, 1.8);
  rim.position.set(1.8, 1.4, -2.2);
  scene.add(rim);
  // 補光：避免暗面死黑
  const fill = new THREE.DirectionalLight(0xffffff, 0.3);
  fill.position.set(2, 0.5, 2);
  scene.add(fill);

  const slot = new THREE.Group();
  scene.add(slot);

  return {
    renderer,
    envMap,
    shot(object, camera) {
      slot.clear();
      slot.add(object);
      renderer.render(scene, camera);
      slot.remove(object);
      return canvas;
    },
  };
}

/* ------------------------------------------------------------
   共用的材質與小工具
   ------------------------------------------------------------ */

const materialCache = new Map<string, THREE.Material>();

/** 公仔的亮面塑膠。同一種顏色共用一個材質，不要每一隻都 new 一個。 */
export function toy(color: string | number, opts: { rough?: number; coat?: number } = {}): THREE.MeshPhysicalMaterial {
  const key = `toy:${color}:${opts.rough ?? ""}:${opts.coat ?? ""}`;
  let m = materialCache.get(key) as THREE.MeshPhysicalMaterial | undefined;
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      roughness: opts.rough ?? 0.38,
      metalness: 0,
      clearcoat: opts.coat ?? 0.55,
      clearcoatRoughness: 0.25,
      envMapIntensity: 0.3,
    });
    materialCache.set(key, m);
  }
  return m;
}

/** 腳底的軟陰影：一張中間深、往外淡掉的圓形貼圖。 */
let shadowTex: THREE.Texture | null = null;
export function blobShadow(radius: number, opacity = 0.35): THREE.Mesh {
  if (!shadowTex) {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d") as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(0,0,0,1)");
    grad.addColorStop(0.5, "rgba(0,0,0,.45)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    shadowTex = new THREE.CanvasTexture(c);
  }
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.002;
  return m;
}

/**
 * 拍角色用的相機：稍微從上往下看，框住腳底到頭頂的花。
 * 回傳相機和「世界座標 → 畫面像素」的對照，2D 那邊要靠它把腳底對到正確位置。
 */
export interface Framing {
  camera: THREE.PerspectiveCamera;
  /** 腳底（世界原點）在 512 圖裡的像素位置 */
  footX: number;
  footY: number;
  /** 世界的 1 單位高 ≈ 圖裡幾像素（在角色所在的深度） */
  pxPerUnit: number;
}

export function framing(viewHeight: number, centerY: number, tilt = 0.25): Framing {
  const fov = 22;
  const dist = viewHeight / 2 / Math.tan(((fov / 2) * Math.PI) / 180);
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 50);
  camera.position.set(0, centerY + dist * tilt * 0.35, dist);
  camera.lookAt(0, centerY, 0);
  camera.updateMatrixWorld();

  const toPx = (v: THREE.Vector3): { x: number; y: number } => {
    const p = v.clone().project(camera);
    return { x: ((p.x + 1) / 2) * SHOT_PX, y: ((1 - p.y) / 2) * SHOT_PX };
  };
  const foot = toPx(new THREE.Vector3(0, 0, 0));
  const top = toPx(new THREE.Vector3(0, 1, 0));
  return { camera, footX: foot.x, footY: foot.y, pxPerUnit: foot.y - top.y };
}
