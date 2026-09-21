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

/* ============================================================
   縣市分界

   ⚠️ 這是示意，不是行政區圖。

   真正的縣市界是幾千個點的多邊形；這裡用的是「中央山脈的稜線」加上
   幾條橫向的分界線，把島切成看得出來的區塊。目的是讓玩家點地圖時
   有參考（「這裡大概是台中」），不是拿來查行政區的。
   彼此接壤的細節、飛地、離島都沒有畫。

   北部的台北／新北／基隆擠在很小的範圍裡，硬要切開在手機上只會變成
   一團線，所以那一塊合成一格寫「雙北基隆」。
   ============================================================ */

/** 中央山脈稜線，由北到南。東西兩側的縣市以它為界。 */
const SPINE: LonLat[] = [
  { lon: 121.62, lat: 25.02 },
  { lon: 121.5, lat: 24.78 },
  { lon: 121.42, lat: 24.5 },
  { lon: 121.3, lat: 24.2 },
  { lon: 121.22, lat: 23.9 },
  { lon: 121.1, lat: 23.6 },
  { lon: 121.0, lat: 23.3 },
  { lon: 120.92, lat: 23.0 },
  { lon: 120.85, lat: 22.7 },
  { lon: 120.75, lat: 22.4 },
];

/**
 * 分界線。每一條是一串點，畫成折線就好，不封閉。
 * 西側的線從西岸拉到稜線，東側的線從稜線拉到東岸。
 */
export const COUNTY_LINES: LonLat[][] = [
  SPINE,
  // ---- 西側，由北到南 ----
  [{ lon: 121.22, lat: 25.02 }, { lon: 121.35, lat: 24.9 }, { lon: 121.5, lat: 24.85 }], // 雙北 / 桃園
  [{ lon: 121.0, lat: 24.93 }, { lon: 121.2, lat: 24.75 }, { lon: 121.44, lat: 24.62 }], // 桃園 / 新竹
  [{ lon: 120.87, lat: 24.72 }, { lon: 121.1, lat: 24.6 }, { lon: 121.4, lat: 24.5 }],   // 新竹 / 苗栗
  [{ lon: 120.64, lat: 24.43 }, { lon: 120.9, lat: 24.35 }, { lon: 121.32, lat: 24.28 }], // 苗栗 / 台中
  [{ lon: 120.45, lat: 24.16 }, { lon: 120.7, lat: 24.1 }, { lon: 120.95, lat: 24.05 }],  // 台中 / 彰化・南投
  [{ lon: 120.6, lat: 24.08 }, { lon: 120.72, lat: 23.85 }, { lon: 120.66, lat: 23.6 }],  // 彰化・雲林 / 南投
  [{ lon: 120.28, lat: 23.82 }, { lon: 120.55, lat: 23.78 }, { lon: 120.8, lat: 23.75 }], // 彰化 / 雲林
  [{ lon: 120.15, lat: 23.5 }, { lon: 120.5, lat: 23.48 }, { lon: 120.9, lat: 23.45 }],   // 雲林 / 嘉義
  [{ lon: 120.12, lat: 23.25 }, { lon: 120.5, lat: 23.2 }, { lon: 120.95, lat: 23.2 }],   // 嘉義 / 台南
  [{ lon: 120.08, lat: 22.9 }, { lon: 120.4, lat: 22.95 }, { lon: 120.85, lat: 23.0 }],   // 台南 / 高雄
  [{ lon: 120.42, lat: 22.5 }, { lon: 120.6, lat: 22.6 }, { lon: 120.72, lat: 22.75 }],   // 高雄 / 屏東
  // ---- 東側，由北到南 ----
  [{ lon: 121.5, lat: 24.78 }, { lon: 121.7, lat: 24.72 }, { lon: 121.86, lat: 24.6 }],   // 雙北 / 宜蘭
  [{ lon: 121.35, lat: 24.35 }, { lon: 121.6, lat: 24.4 }, { lon: 121.78, lat: 24.42 }],  // 宜蘭 / 花蓮
  [{ lon: 121.05, lat: 23.4 }, { lon: 121.25, lat: 23.35 }, { lon: 121.42, lat: 23.28 }], // 花蓮 / 台東
];

/** 縣市名與標的位置。位置是「大概的中心」，不是政府所在地。 */
export const COUNTY_LABELS: { name: string; lon: number; lat: number }[] = [
  { name: "雙北基隆", lon: 121.55, lat: 25.08 },
  { name: "桃園", lon: 121.15, lat: 24.92 },
  { name: "新竹", lon: 121.0, lat: 24.68 },
  { name: "苗栗", lon: 120.85, lat: 24.45 },
  { name: "台中", lon: 120.75, lat: 24.2 },
  { name: "彰化", lon: 120.45, lat: 23.95 },
  { name: "南投", lon: 120.9, lat: 23.85 },
  { name: "雲林", lon: 120.35, lat: 23.65 },
  { name: "嘉義", lon: 120.45, lat: 23.35 },
  { name: "台南", lon: 120.3, lat: 23.05 },
  { name: "高雄", lon: 120.5, lat: 22.8 },
  { name: "屏東", lon: 120.62, lat: 22.4 },
  { name: "宜蘭", lon: 121.65, lat: 24.6 },
  { name: "花蓮", lon: 121.4, lat: 23.8 },
  { name: "台東", lon: 121.05, lat: 22.9 },
];

/** 縣市界的路徑字串，座標是 0..1 乘上寬高。跟 outlinePath 同一個用法。 */
export function countyPaths(w: number, h: number): string[] {
  return COUNTY_LINES.map((line) =>
    line
      .map((p, i) => {
        const { x, y } = project(p);
        return `${i === 0 ? "M" : "L"}${(x * w).toFixed(2)} ${(y * h).toFixed(2)}`;
      })
      .join(""),
  );
}
