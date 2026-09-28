/* ============================================================
   台灣地圖

   地理達人用的。手機上畫 SVG 讓玩家點，投影幕上畫 canvas 看大家點在哪，
   兩邊要是同一份座標才不會歪掉，所以放在 shared。

   為什麼存經緯度而不是直接存畫面座標：
   分數要用「差幾公里」算才有意義。存畫面座標的話，地圖一改比例
   所有題目的分數就全變了；而且「差 0.03 個畫面寬」沒有人聽得懂，
   「差 12 公里」大家馬上知道差多少。

   海岸線與縣市界是內政部的開放資料，簡化到約 400 公尺
   （見 taiwanData.ts）。手機上約 100×170 的格子、投影幕上幾百像素，
   這個精度已經比畫面能顯示的還細。
   ============================================================ */

import { BORDER_DATA, COAST_DATA } from "./taiwanData";

export interface LonLat {
  lon: number;
  lat: number;
}

/** 把 taiwanData.ts 裡的差分字串解回經緯度。 */
function decode(str: string): LonLat[] {
  const n = str.split(",").map(Number);
  const out: LonLat[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < n.length; i += 2) {
    x += n[i] as number;
    y += n[i + 1] as number;
    out.push({ lon: x / 1000, lat: y / 1000 });
  }
  return out;
}

/** 海岸線（本島＋綠島、蘭嶼、龜山島），每一圈是一個封閉多邊形。 */
export const COAST: LonLat[][] = COAST_DATA.map(decode);
/** 縣市界，每一條是一段折線（不封閉）。 */
export const BORDERS: LonLat[][] = BORDER_DATA.map(decode);

/* 投影範圍。留一點邊，島不會貼著框。 */
const LON_MIN = 119.95;
const LON_MAX = 122.05;
const LAT_MIN = 21.85;
const LAT_MAX = 25.35;

/** 經緯度 → 0..1 的畫面座標（y 往下為正）。 */
export function project(p: LonLat): { x: number; y: number } {
  return {
    x: (p.lon - LON_MIN) / (LON_MAX - LON_MIN),
    y: (LAT_MAX - p.lat) / (LAT_MAX - LAT_MIN),
  };
}

/** 0..1 的畫面座標 → 經緯度。玩家點下去之後要換回來算距離。 */
export function unproject(x: number, y: number): LonLat {
  return {
    lon: LON_MIN + x * (LON_MAX - LON_MIN),
    lat: LAT_MAX - y * (LAT_MAX - LAT_MIN),
  };
}

/** 兩點差幾公里。 */
export function distanceKm(a: LonLat, b: LonLat): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * 距離換分數。
 *
 * 10 公里內幾乎滿分（同一個市區內算猜對），100 公里歸零
 * （台灣南北才 380 公里，差 100 公里等於猜到別的縣市去了）。
 */
export function geoScore(km: number): number {
  if (km <= 10) return 100;
  return Math.max(0, Math.round(100 * (1 - (km - 10) / 90)));
}

/** SVG / canvas 都能用的路徑字串，座標是 0..1，畫的時候自己乘寬高。 */
export function outlinePath(w: number, h: number): string {
  return COAST.map((ring) => linePath(ring, w, h) + "Z").join("");
}

function linePath(pts: LonLat[], w: number, h: number): string {
  return pts
    .map((p, i) => {
      const { x, y } = project(p);
      return `${i === 0 ? "M" : "L"}${(x * w).toFixed(2)} ${(y * h).toFixed(2)}`;
    })
    .join("");
}

/* ============================================================
   縣市分界與名稱

   界線是真的行政區界（見 taiwanData.ts），標籤的位置是各縣市
   最大那一塊的面積重心，再手動挪了幾個：
   - 新北市包著台北市，重心會落在台北市裡面，所以移到烏來那一帶
   - 新竹市、嘉義市太小，字寫不下，併進新竹、嘉義那一個字
   ============================================================ */

/** 縣市名與標的位置。 */
export const COUNTY_LABELS: { name: string; lon: number; lat: number }[] = [
  { name: "基隆", lon: 121.8, lat: 25.19 }, // 基隆太小，字放到外海
  { name: "台北", lon: 121.56, lat: 25.08 },
  { name: "新北", lon: 121.6, lat: 24.86 },
  { name: "桃園", lon: 121.24, lat: 24.9 },
  { name: "新竹", lon: 121.13, lat: 24.68 },
  { name: "苗栗", lon: 120.92, lat: 24.48 },
  { name: "台中", lon: 120.88, lat: 24.24 },
  { name: "彰化", lon: 120.47, lat: 23.96 },
  { name: "南投", lon: 120.98, lat: 23.84 },
  { name: "雲林", lon: 120.38, lat: 23.69 },
  { name: "嘉義", lon: 120.52, lat: 23.44 },
  { name: "台南", lon: 120.32, lat: 23.15 },
  { name: "高雄", lon: 120.6, lat: 22.98 },
  { name: "屏東", lon: 120.68, lat: 22.48 },
  { name: "宜蘭", lon: 121.64, lat: 24.57 },
  { name: "花蓮", lon: 121.38, lat: 23.75 },
  { name: "台東", lon: 121.03, lat: 22.88 },
];

/** 縣市界的路徑字串，座標是 0..1 乘上寬高。跟 outlinePath 同一個用法。 */
export function countyPaths(w: number, h: number): string[] {
  return BORDERS.map((line) => linePath(line, w, h));
}
