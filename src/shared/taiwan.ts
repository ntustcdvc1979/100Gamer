/* ============================================================
   台灣地圖

   地理達人用的。手機上畫 SVG 讓玩家點，投影幕上畫 canvas 看大家點在哪，
   兩邊要是同一份座標才不會歪掉，所以放在 shared。

   為什麼存經緯度而不是直接存畫面座標：
   分數要用「差幾公里」算才有意義。存畫面座標的話，地圖一改比例
   所有題目的分數就全變了；而且「差 0.03 個畫面寬」沒有人聽得懂，
   「差 12 公里」大家馬上知道差多少。

   輪廓是手工簡化的海岸線（約 30 個點）。不是精確測繪，
   目的是讓人一眼認出台灣、點得到位置，不是拿來導航的。
   ============================================================ */

export interface LonLat {
  lon: number;
  lat: number;
}

/** 逆時針從北端富貴角開始，沿西岸南下、繞過鵝鑾鼻、再沿東岸北上。 */
export const OUTLINE: LonLat[] = [
  { lon: 121.54, lat: 25.3 },   // 富貴角
  { lon: 121.41, lat: 25.18 },  // 淡水
  { lon: 121.1, lat: 25.02 },   // 桃園
  { lon: 120.93, lat: 24.83 },  // 新竹
  { lon: 120.76, lat: 24.6 },   // 苗栗
  { lon: 120.52, lat: 24.28 },  // 台中港
  { lon: 120.42, lat: 24.05 },  // 彰化
  { lon: 120.15, lat: 23.55 },  // 雲林
  { lon: 120.15, lat: 23.45 },  // 東石
  { lon: 120.1, lat: 23.05 },   // 台南
  { lon: 120.27, lat: 22.62 },  // 高雄
  { lon: 120.4, lat: 22.48 },   // 林園
  { lon: 120.59, lat: 22.37 },  // 枋寮
  { lon: 120.7, lat: 22.18 },   // 楓港
  { lon: 120.85, lat: 21.9 },   // 鵝鑾鼻
  { lon: 120.88, lat: 22.05 },  // 滿州
  { lon: 120.9, lat: 22.35 },   // 大武
  { lon: 121.0, lat: 22.6 },    // 太麻里
  { lon: 121.15, lat: 22.75 },  // 台東
  { lon: 121.37, lat: 23.1 },   // 成功
  { lon: 121.47, lat: 23.32 },  // 長濱
  { lon: 121.61, lat: 23.98 },  // 花蓮
  { lon: 121.75, lat: 24.3 },   // 和平
  { lon: 121.8, lat: 24.46 },   // 南澳
  { lon: 121.86, lat: 24.6 },   // 蘇澳
  { lon: 121.82, lat: 24.86 },  // 頭城
  { lon: 122.0, lat: 25.01 },   // 三貂角
  { lon: 121.75, lat: 25.15 },  // 基隆
];

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
  return (
    OUTLINE.map((p, i) => {
      const { x, y } = project(p);
      return `${i === 0 ? "M" : "L"}${(x * w).toFixed(2)} ${(y * h).toFixed(2)}`;
    }).join("") + "Z"
  );
}
