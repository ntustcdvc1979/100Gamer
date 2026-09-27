/* ============================================================
   卡通風格的畫筆（主視覺 group.png 的樣子）

   投影幕上的皮克敏、天空、草地、木牌、圓角卡片都在這裡畫。
   全部用 canvas 當場畫，不用圖檔：
     - 一百隻小皮克敏要能各自走路、眨眼、從土裡冒出來，圖檔做不到；
     - 投影幕那台可能是現場自架、沒有外網，不能指望去抓素材；
     - 主視覺那張圖 20 MB，而且角色背景是畫死的，裁不出乾淨的角色。

   ⚠️ 只有「卡通主題」的關卡（Game.cartoon）用這一套。
   其他關卡還是深色底白字 —— 那些文字色都是照深底挑的，
   換成亮天空會整個看不見。
   ============================================================ */

import { TEAMS, type TeamId } from "../shared/teams";

/** 圓體。主視覺用的是圓圓胖胖的字，粉圓最接近，而且有繁中。 */
export const FONT = `"Huninn", "Noto Sans TC", system-ui, sans-serif`;

export function font(px: number, weight = 900): string {
  return `${weight} ${Math.round(px)}px ${FONT}`;
}

/* ------------------------------------------------------------
   顏色小工具
   ------------------------------------------------------------ */

/** 把 #RRGGBB 調亮（amt > 0）或調暗（amt < 0），-1..1。 */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number): number => {
    const out = amt >= 0 ? v + (255 - v) * amt : v * (1 + amt);
    return Math.max(0, Math.min(255, Math.round(out)));
  };
  const r = ch((n >> 16) & 255);
  const gg = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `rgb(${r},${gg},${b})`;
}

/* ------------------------------------------------------------
   背景：天空、雲、草地
   ------------------------------------------------------------ */

/** 天空漸層加幾朵慢慢飄的雲。warm = 火候達人的廚房暖色。 */
export function sky(g: CanvasRenderingContext2D, w: number, h: number, t: number, warm = false): void {
  const grad = g.createLinearGradient(0, 0, 0, h);
  if (warm) {
    grad.addColorStop(0, "#FFB76B");
    grad.addColorStop(0.55, "#FFE2A8");
    grad.addColorStop(1, "#FFF3D6");
  } else {
    grad.addColorStop(0, "#4FA3F7");
    grad.addColorStop(0.6, "#A8DBFF");
    grad.addColorStop(1, "#E7F7FF");
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // 雲。位置用時間推，繞一圈回來，不用存狀態。
  const unit = Math.min(w, h) / 100;
  g.fillStyle = warm ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.85)";
  const clouds = [
    [0.1, 0.12, 1.0, 0.012],
    [0.45, 0.07, 0.8, 0.008],
    [0.75, 0.2, 1.2, 0.01],
    [0.3, 0.28, 0.7, 0.015],
  ];
  for (const [x0, y0, s, v] of clouds) {
    const x = (((x0 as number) + (t / 1000) * (v as number)) % 1.3) - 0.15;
    cloud(g, x * w, (y0 as number) * h, unit * 7 * (s as number));
  }
}

function cloud(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.arc(x + r * 1.1, y - r * 0.35, r * 1.1, 0, Math.PI * 2);
  g.arc(x + r * 2.2, y, r * 0.9, 0, Math.PI * 2);
  g.arc(x + r * 1.1, y + r * 0.3, r * 0.95, 0, Math.PI * 2);
  g.fill();
}

/** 起伏的草地，從 top 一路鋪到畫面底。 */
export function meadow(g: CanvasRenderingContext2D, w: number, h: number, top: number, t: number): void {
  // 遠山
  g.fillStyle = "#8FD16A";
  g.beginPath();
  g.moveTo(0, h);
  g.lineTo(0, top + (h - top) * 0.1);
  for (let x = 0; x <= w; x += w / 40) {
    g.lineTo(x, top + Math.sin(x / w * 7 + 1) * (h - top) * 0.06);
  }
  g.lineTo(w, h);
  g.fill();

  // 近處的草
  const grad = g.createLinearGradient(0, top, 0, h);
  grad.addColorStop(0, "#6CC24A");
  grad.addColorStop(1, "#3E9A2F");
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(0, h);
  for (let x = 0; x <= w; x += w / 40) {
    g.lineTo(x, top + (h - top) * 0.12 + Math.sin(x / w * 11) * (h - top) * 0.04);
  }
  g.lineTo(w, h);
  g.fill();

  // 小白花與草叢。位置用固定的亂數種子，不會每幀跳。
  const unit = Math.min(w, h) / 100;
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 40; i++) {
    const x = rnd() * w;
    const y = top + (h - top) * (0.25 + rnd() * 0.75);
    const sway = Math.sin(t / 700 + i) * unit * 0.3;
    if (i % 3 === 0) flowerDot(g, x + sway, y, unit * 0.9);
    else grassTuft(g, x, y, unit * 1.6, sway);
  }
}

function grassTuft(g: CanvasRenderingContext2D, x: number, y: number, s: number, sway: number): void {
  g.strokeStyle = "#2F7F24";
  g.lineWidth = Math.max(1, s * 0.18);
  g.lineCap = "round";
  for (const dx of [-0.5, 0, 0.5]) {
    g.beginPath();
    g.moveTo(x + dx * s, y);
    g.quadraticCurveTo(x + dx * s * 1.4 + sway, y - s * 0.6, x + dx * s * 1.8 + sway, y - s);
    g.stroke();
  }
}

function flowerDot(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.fillStyle = "#FFFFFF";
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    g.beginPath();
    g.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.75, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#FFCF3F";
  g.beginPath();
  g.arc(x, y, r * 0.6, 0, Math.PI * 2);
  g.fill();
}

/* ------------------------------------------------------------
   版面元件：圓角卡片、木牌、描邊大字、倒數圓章
   ------------------------------------------------------------ */

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** 主視覺那種厚白邊、帶陰影的圓角卡片。 */
export function card(
  g: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  fill: string | CanvasGradient,
  unit: number,
  border = "#FFFFFF",
): void {
  g.save();
  g.shadowColor = "rgba(0,0,0,.22)";
  g.shadowBlur = unit * 2;
  g.shadowOffsetY = unit * 0.6;
  roundRect(g, x, y, w, h, unit * 3);
  g.fillStyle = fill;
  g.fill();
  g.restore();
  roundRect(g, x, y, w, h, unit * 3);
  g.strokeStyle = border;
  g.lineWidth = unit * 0.7;
  g.stroke();
}

/** 木牌。主視覺底下那塊「不同的色彩・同一個目標」。 */
export function woodSign(
  g: CanvasRenderingContext2D,
  cx: number, cy: number,
  text: string,
  px: number,
  unit: number,
): void {
  g.font = font(px);
  const tw = g.measureText(text).width;
  const w = tw + px * 1.6;
  const h = px * 1.9;
  const x = cx - w / 2;
  const y = cy - h / 2;

  g.save();
  g.shadowColor = "rgba(0,0,0,.25)";
  g.shadowBlur = unit * 1.5;
  g.shadowOffsetY = unit * 0.5;
  roundRect(g, x, y, w, h, px * 0.35);
  const wood = g.createLinearGradient(0, y, 0, y + h);
  wood.addColorStop(0, "#B97A45");
  wood.addColorStop(1, "#8A5428");
  g.fillStyle = wood;
  g.fill();
  g.restore();

  // 木紋
  g.strokeStyle = "rgba(90,50,20,.35)";
  g.lineWidth = Math.max(1, px * 0.06);
  for (const f of [0.33, 0.66]) {
    g.beginPath();
    g.moveTo(x + px * 0.4, y + h * f);
    g.lineTo(x + w - px * 0.4, y + h * f);
    g.stroke();
  }
  // 釘子
  g.fillStyle = "#5A3517";
  for (const nx of [x + px * 0.45, x + w - px * 0.45]) {
    g.beginPath();
    g.arc(nx, cy, px * 0.12, 0, Math.PI * 2);
    g.fill();
  }

  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#FFF8E8";
  g.fillText(text, cx, cy + px * 0.05);
}

/** 白色描邊的大字，主視覺標題那種。 */
export function bigText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number, y: number,
  px: number,
  fill: string,
  stroke = "#FFFFFF",
  align: CanvasTextAlign = "center",
): void {
  g.font = font(px);
  g.textAlign = align;
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.save();
  g.shadowColor = "rgba(0,0,0,.25)";
  g.shadowBlur = px * 0.15;
  g.shadowOffsetY = px * 0.06;
  g.strokeStyle = stroke;
  g.lineWidth = px * 0.22;
  g.strokeText(text, x, y);
  g.restore();
  g.fillStyle = fill;
  g.fillText(text, x, y);
}

/** 倒數用的黃色圓章。urgent = 最後五秒，會跳動變紅。 */
export function timerBadge(
  g: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  label: string,
  t: number,
  urgent = false,
): void {
  const pulse = urgent ? 1 + Math.sin(t / 90) * 0.06 : 1;
  const rr = r * pulse;
  g.save();
  g.shadowColor = "rgba(0,0,0,.25)";
  g.shadowBlur = r * 0.3;
  g.shadowOffsetY = r * 0.08;
  g.fillStyle = urgent ? "#FF5A4E" : "#FFD23F";
  g.beginPath();
  g.arc(cx, cy, rr, 0, Math.PI * 2);
  g.fill();
  g.restore();
  g.strokeStyle = "#FFFFFF";
  g.lineWidth = r * 0.14;
  g.beginPath();
  g.arc(cx, cy, rr, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = urgent ? "#FFFFFF" : "#5A3A00";
  g.font = font(r * (label.length > 2 ? 0.62 : 0.95));
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, cx, cy + r * 0.05);
}

/* ------------------------------------------------------------
   皮克敏

   (x, y) 是腳底中心，h 是整隻的高度（含頭上的葉子或花）。
   比例照主視覺：大頭、小身體、細腳，頭頂一根莖。
   ------------------------------------------------------------ */

export interface PikminPose {
  /** 動畫時間（毫秒），每隻加一點位移才不會整群同步 */
  t: number;
  /** 各自的相位，讓一群皮克敏不要一起眨眼、一起擺動 */
  phase?: number;
  /** 0..1，走路／跑步的速度。0 = 站著 */
  walk?: number;
  /** 往哪邊看。1 = 右，-1 = 左 */
  face?: 1 | -1;
  /** 身體往後傾（拔蘿蔔用），弧度 */
  lean?: number;
  /** 舉手揮動 */
  wave?: boolean;
  /** 戴廚師帽（火候達人） */
  chef?: boolean;
}

export function pikmin(
  g: CanvasRenderingContext2D,
  x: number, y: number, h: number,
  team: TeamId,
  pose: PikminPose,
): void {
  const def = TEAMS[team];
  const body = def.color;
  const outline = def.light ? "#C9CED8" : shade(body, -0.35);
  const ph = pose.phase ?? 0;
  const t = pose.t + ph * 1000;
  const walk = pose.walk ?? 0;
  const face = pose.face ?? 1;

  // 走路時上下彈，站著時慢慢呼吸
  const bob = walk > 0 ? Math.abs(Math.sin(t / (140 - walk * 60))) * h * 0.05 : Math.sin(t / 600) * h * 0.012;
  const legSwing = walk > 0 ? Math.sin(t / (140 - walk * 60)) * h * 0.06 : 0;

  g.save();
  g.translate(x, y);
  g.rotate(pose.lean ?? 0);
  g.lineCap = "round";
  g.lineJoin = "round";

  const legLen = h * 0.12;
  const hipY = -legLen - bob;
  const bodyCy = hipY - h * 0.1;
  const headCy = bodyCy - h * 0.25;
  const headRx = h * 0.17;
  const headRy = h * 0.2;

  // 腳
  g.strokeStyle = shade(body === "#FFFFFF" ? "#E4E7EE" : body, -0.1);
  g.lineWidth = h * 0.045;
  g.beginPath();
  g.moveTo(-h * 0.04, hipY);
  g.lineTo(-h * 0.04 + legSwing, 0);
  g.moveTo(h * 0.04, hipY);
  g.lineTo(h * 0.04 - legSwing, 0);
  g.stroke();

  // 身體
  g.fillStyle = body;
  g.strokeStyle = outline;
  g.lineWidth = Math.max(1, h * 0.015);
  g.beginPath();
  g.ellipse(0, bodyCy, h * 0.09, h * 0.12, 0, 0, Math.PI * 2);
  g.fill();
  g.stroke();

  // 手：揮手的話一隻舉高
  const armY = bodyCy - h * 0.04;
  g.strokeStyle = body === "#FFFFFF" ? "#E4E7EE" : body;
  g.lineWidth = h * 0.04;
  g.beginPath();
  g.moveTo(-h * 0.08, armY);
  g.lineTo(-h * 0.17, armY + h * 0.08 + legSwing * 0.5);
  g.moveTo(h * 0.08, armY);
  if (pose.wave) {
    const wv = Math.sin(t / 160) * h * 0.05;
    g.lineTo(h * 0.2 + wv, armY - h * 0.14);
  } else {
    g.lineTo(h * 0.17, armY + h * 0.08 - legSwing * 0.5);
  }
  g.stroke();

  // 黃皮克敏的大耳朵
  if (team === "C") {
    g.fillStyle = body;
    g.strokeStyle = outline;
    g.lineWidth = Math.max(1, h * 0.012);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(s * headRx * 0.7, headCy - headRy * 0.2);
      g.lineTo(s * headRx * 2.0, headCy - headRy * 0.55);
      g.lineTo(s * headRx * 0.85, headCy + headRy * 0.25);
      g.closePath();
      g.fill();
      g.stroke();
    }
  }

  // 頭：上尖下圓的水滴形，左上打亮
  const hg = g.createRadialGradient(-headRx * 0.35, headCy - headRy * 0.4, headRx * 0.1, 0, headCy, headRy * 1.2);
  hg.addColorStop(0, def.light ? "#FFFFFF" : shade(body, 0.35));
  hg.addColorStop(1, def.light ? "#E9ECF2" : body);
  g.fillStyle = hg;
  g.strokeStyle = outline;
  g.lineWidth = Math.max(1, h * 0.015);
  g.beginPath();
  g.moveTo(0, headCy - headRy * 1.15);
  g.bezierCurveTo(headRx * 0.9, headCy - headRy * 0.9, headRx * 1.1, headCy + headRy * 0.2, 0, headCy + headRy);
  g.bezierCurveTo(-headRx * 1.1, headCy + headRy * 0.2, -headRx * 0.9, headCy - headRy * 0.9, 0, headCy - headRy * 1.15);
  g.fill();
  g.stroke();

  // 眼睛。偶爾眨一下 —— 一群都睜著眼的皮克敏看起來很僵。
  const blink = (t % 3800) < 120;
  const eyeY = headCy + headRy * 0.05;
  const eyeDx = headRx * 0.42;
  const eyeR = headRx * 0.3;
  const look = face * eyeR * 0.25;
  for (const s of [-1, 1]) {
    const ex = s * eyeDx;
    if (blink) {
      g.strokeStyle = "#2A1A10";
      g.lineWidth = Math.max(1, eyeR * 0.3);
      g.beginPath();
      g.moveTo(ex - eyeR * 0.8, eyeY);
      g.lineTo(ex + eyeR * 0.8, eyeY);
      g.stroke();
      continue;
    }
    if (team === "D") {
      // 白皮克敏是一雙紅眼睛，沒有眼白
      g.fillStyle = "#D8202A";
      g.beginPath();
      g.arc(ex + look * 0.4, eyeY, eyeR * 0.95, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#FFFFFF";
      g.beginPath();
      g.arc(ex + look * 0.4 - eyeR * 0.3, eyeY - eyeR * 0.35, eyeR * 0.28, 0, Math.PI * 2);
      g.fill();
    } else {
      g.fillStyle = "#FFFFFF";
      g.beginPath();
      g.arc(ex, eyeY, eyeR, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#1B1B1F";
      g.beginPath();
      g.arc(ex + look, eyeY + eyeR * 0.08, eyeR * 0.55, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#FFFFFF";
      g.beginPath();
      g.arc(ex + look - eyeR * 0.2, eyeY - eyeR * 0.2, eyeR * 0.18, 0, Math.PI * 2);
      g.fill();
    }
  }

  // 藍皮克敏有嘴巴，紅皮克敏有個尖鼻子
  if (team === "B") {
    g.fillStyle = "#12245A";
    g.beginPath();
    g.ellipse(0, eyeY + headRy * 0.45, headRx * 0.18, headRx * 0.12, 0, 0, Math.PI * 2);
    g.fill();
  } else if (team === "A") {
    g.fillStyle = shade(body, -0.12);
    g.beginPath();
    g.moveTo(face * headRx * 0.05, eyeY + headRy * 0.2);
    g.lineTo(face * headRx * 0.45, eyeY + headRy * 0.35);
    g.lineTo(face * headRx * 0.05, eyeY + headRy * 0.45);
    g.fill();
  }

  // 廚師帽
  if (pose.chef) {
    g.fillStyle = "#FFFFFF";
    g.strokeStyle = "#D5D9E0";
    g.lineWidth = Math.max(1, h * 0.01);
    const capY = headCy - headRy * 0.95;
    g.fillRect(-headRx * 0.7, capY - headRy * 0.2, headRx * 1.4, headRy * 0.3);
    g.strokeRect(-headRx * 0.7, capY - headRy * 0.2, headRx * 1.4, headRy * 0.3);
    g.beginPath();
    g.arc(-headRx * 0.4, capY - headRy * 0.35, headRx * 0.45, 0, Math.PI * 2);
    g.arc(headRx * 0.4, capY - headRy * 0.35, headRx * 0.45, 0, Math.PI * 2);
    g.arc(0, capY - headRy * 0.6, headRx * 0.5, 0, Math.PI * 2);
    g.fill();
    // 帽子在暖色牆面前會糊掉，描一圈邊
    g.strokeStyle = "#B9BFCB";
    g.lineWidth = Math.max(1, h * 0.012);
    g.stroke();
  }

  // 莖和葉子／花。會跟著時間輕輕擺。
  const sway = Math.sin(t / 500) * h * 0.05 + walk * face * -h * 0.06;
  const stemTop = headCy - headRy * 1.1;
  const tipX = sway;
  const tipY = stemTop - h * 0.22;
  g.strokeStyle = "#3E7F2A";
  g.lineWidth = Math.max(1, h * 0.022);
  g.beginPath();
  g.moveTo(0, stemTop);
  g.quadraticCurveTo(sway * 0.2, stemTop - h * 0.12, tipX, tipY);
  g.stroke();

  if (def.sprout === "leaf") {
    g.save();
    g.translate(tipX, tipY);
    g.rotate(-0.6 + sway / h);
    const lg = g.createLinearGradient(0, -h * 0.08, 0, h * 0.08);
    lg.addColorStop(0, "#7BD34E");
    lg.addColorStop(1, "#3F9A2A");
    g.fillStyle = lg;
    g.beginPath();
    g.ellipse(h * 0.08, 0, h * 0.1, h * 0.05, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#2F7A1F";
    g.lineWidth = Math.max(1, h * 0.008);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(h * 0.16, 0);
    g.stroke();
    g.restore();
  } else {
    const pr = h * 0.055;
    g.fillStyle = "#FFFFFF";
    g.strokeStyle = "#D8DCE4";
    g.lineWidth = Math.max(1, h * 0.006);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + t / 3000;
      g.beginPath();
      g.ellipse(tipX + Math.cos(a) * pr, tipY + Math.sin(a) * pr, pr * 0.9, pr * 0.55, a, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.fillStyle = "#FFC21F";
    g.beginPath();
    g.arc(tipX, tipY, pr * 0.6, 0, Math.PI * 2);
    g.fill();
  }

  g.restore();
}

/* ------------------------------------------------------------
   道具：蘿蔔、彩帶
   ------------------------------------------------------------ */

/** 一根蘿蔔。(x, y) 是蘿蔔頭（葉子根部）的位置，s 是長度。 */
export function carrot(g: CanvasRenderingContext2D, x: number, y: number, s: number, rot = 0): void {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  // 葉子
  g.fillStyle = "#4CAF3A";
  for (const a of [-0.5, 0, 0.5]) {
    g.save();
    g.rotate(a);
    g.beginPath();
    g.ellipse(0, -s * 0.2, s * 0.07, s * 0.22, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  // 身體
  const cg = g.createLinearGradient(-s * 0.15, 0, s * 0.15, 0);
  cg.addColorStop(0, "#FF9A2E");
  cg.addColorStop(1, "#E86A10");
  g.fillStyle = cg;
  g.beginPath();
  g.moveTo(-s * 0.16, 0);
  g.quadraticCurveTo(-s * 0.14, s * 0.5, 0, s * 0.85);
  g.quadraticCurveTo(s * 0.14, s * 0.5, s * 0.16, 0);
  g.closePath();
  g.fill();
  // 紋路
  g.strokeStyle = "rgba(150,60,0,.45)";
  g.lineWidth = Math.max(1, s * 0.02);
  for (const f of [0.25, 0.45, 0.62]) {
    g.beginPath();
    g.moveTo(-s * 0.12 * (1 - f * 0.6), s * f);
    g.lineTo(-s * 0.02, s * f + s * 0.02);
    g.stroke();
  }
  g.restore();
}

interface Confetto {
  x: number; y: number; vx: number; vy: number;
  rot: number; spin: number; color: string; born: number;
}

/** 灑彩帶。慶祝用，純視覺。 */
export function createConfetti(): {
  burst(x: number, y: number, n: number, now: number, colors?: string[]): void;
  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number, dt: number): void;
  clear(): void;
} {
  let bits: Confetto[] = [];
  const palette = ["#E53935", "#F4C12E", "#2D6CDF", "#FFFFFF", "#6CC24A", "#FF8FC8"];
  return {
    burst(x, y, n, now, colors = palette) {
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
        const sp = 0.4 + Math.random() * 0.8;
        bits.push({
          x, y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          rot: Math.random() * 6, spin: (Math.random() - 0.5) * 12,
          color: colors[i % colors.length] as string,
          born: now,
        });
      }
      // 上限，不然一直慶祝會把投影幕拖慢
      if (bits.length > 600) bits = bits.slice(-600);
    },
    draw(g, w, h, now, dt) {
      const unit = Math.min(w, h) / 100;
      bits = bits.filter((b) => now - b.born < 3500 && b.y < 1.1);
      for (const b of bits) {
        b.vy += 0.9 * dt;
        b.vx *= 0.99;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.rot += b.spin * dt;
        g.save();
        g.translate(b.x * w, b.y * h);
        g.rotate(b.rot);
        g.fillStyle = b.color;
        g.fillRect(-unit * 0.5, -unit * 0.25, unit, unit * 0.5);
        g.restore();
      }
    },
    clear() {
      bits = [];
    },
  };
}
