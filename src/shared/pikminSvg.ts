/* ============================================================
   手機上用的小皮克敏（SVG 字串）

   投影幕那邊的皮克敏是 canvas 畫的（stage/cartoon.ts），會走路會眨眼；
   手機只需要選隊按鈕上一隻靜態的小圖示，所以這裡用 SVG 字串就好 ——
   不用載任何圖檔，一百支手機走行動網路也不會多吃流量。
   ============================================================ */

import { TEAMS, type TeamId } from "./teams";

export function pikminSvg(team: TeamId, size = 56): string {
  const t = TEAMS[team];
  const body = t.color;
  const line = t.light ? "#B8C0CE" : "rgba(0,0,0,.28)";
  const eyes =
    team === "D"
      ? // 白皮克敏：紅眼睛，沒有眼白
        `<circle cx="42" cy="54" r="5.5" fill="#D8202A"/><circle cx="58" cy="54" r="5.5" fill="#D8202A"/>`
      : `<circle cx="42" cy="54" r="6" fill="#fff"/><circle cx="58" cy="54" r="6" fill="#fff"/>` +
        `<circle cx="43" cy="55" r="3.3" fill="#1B1B1F"/><circle cx="59" cy="55" r="3.3" fill="#1B1B1F"/>`;
  const ears =
    team === "C"
      ? `<path d="M36 46 L18 36 L34 60 Z" fill="${body}" stroke="${line}" stroke-width="1.5"/>` +
        `<path d="M64 46 L82 36 L66 60 Z" fill="${body}" stroke="${line}" stroke-width="1.5"/>`
      : "";
  const mouth = team === "B" ? `<ellipse cx="50" cy="66" rx="3.5" ry="2.4" fill="#12245A"/>` : "";
  const sprout =
    t.sprout === "leaf"
      ? `<ellipse cx="62" cy="10" rx="11" ry="5.5" fill="#5DBB3A" transform="rotate(-25 62 10)"/>`
      : `<g fill="#fff" stroke="#D8DCE4" stroke-width="1">` +
        [0, 72, 144, 216, 288]
          .map((a) => `<ellipse cx="56" cy="6" rx="5" ry="3" transform="rotate(${a} 56 12) translate(0 -1)"/>`)
          .join("") +
        `</g><circle cx="56" cy="12" r="3.2" fill="#FFC21F"/>`;

  return (
    `<svg viewBox="0 0 100 110" width="${size}" height="${Math.round(size * 1.1)}" aria-hidden="true">` +
    `<path d="M50 30 Q52 18 56 12" stroke="#3E7F2A" stroke-width="2.5" fill="none" stroke-linecap="round"/>` +
    sprout +
    ears +
    // 頭：上尖下圓
    `<path d="M50 30 C66 34 70 56 50 76 C30 56 34 34 50 30 Z" fill="${body}" stroke="${line}" stroke-width="1.5"/>` +
    eyes +
    mouth +
    // 身體和腳
    `<ellipse cx="50" cy="86" rx="9" ry="10" fill="${body}" stroke="${line}" stroke-width="1.5"/>` +
    `<path d="M46 95 L45 106 M54 95 L55 106" stroke="${t.light ? "#D5DAE3" : body}" stroke-width="4" stroke-linecap="round"/>` +
    `</svg>`
  );
}
