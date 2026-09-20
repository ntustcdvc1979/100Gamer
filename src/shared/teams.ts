/** 隊伍定義。顏色要在投影幕上分得開，也要在手機整面塗滿時好看。 */

export const TEAM_IDS = ["A", "B", "C", "D"] as const;
export type TeamId = (typeof TEAM_IDS)[number];

export interface TeamDef {
  id: TeamId;
  name: string;
  /** 手機整面的底色，也是投影幕上這一隊的點的顏色 */
  color: string;
  /** 疊在底色上的文字色 */
  ink: string;
  /**
   * 底色淺不淺。
   *
   * 風象是白的，投影幕的底是深色、名字也是白的 —— 不特別處理的話，
   * 風象的點會跟白色文字糊在一起，勾選的白邊更是整個看不見。
   * 需要對比的地方（外框、勾選環）就靠這個旗標換成深色。
   */
  light?: boolean;
}

export const TEAMS: Record<TeamId, TeamDef> = {
  A: { id: "A", name: "火象", color: "#E4572E", ink: "#FFFFFF" },
  B: { id: "B", name: "水象", color: "#3B9BD6", ink: "#FFFFFF" },
  C: { id: "C", name: "土象", color: "#D9A441", ink: "#3A2A10" },
  D: { id: "D", name: "風象", color: "#FFFFFF", ink: "#2A2A30", light: true },
};

/** 座位號 → 隊伍。玩家自己選隊之後只剩假玩家在用。 */
export function teamForSeat(seat: number, teamCount: number): TeamId {
  const n = Math.max(1, Math.min(teamCount, TEAM_IDS.length));
  return TEAM_IDS[((seat % n) + n) % n] as TeamId;
}
