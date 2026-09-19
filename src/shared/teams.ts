/** 隊伍定義。顏色要在投影幕上分得開，也要在手機整面塗滿時好看。 */

export const TEAM_IDS = ["A", "B", "C", "D"] as const;
export type TeamId = (typeof TEAM_IDS)[number];

export interface TeamDef {
  id: TeamId;
  name: string;
  /** 手機整面的底色 */
  color: string;
  /** 疊在底色上的文字色 */
  ink: string;
}

export const TEAMS: Record<TeamId, TeamDef> = {
  A: { id: "A", name: "紅隊", color: "#E4572E", ink: "#FFFFFF" },
  B: { id: "B", name: "黃隊", color: "#F2A72C", ink: "#3A2A10" },
  C: { id: "C", name: "綠隊", color: "#5C9E31", ink: "#FFFFFF" },
  D: { id: "D", name: "藍隊", color: "#2E6FA7", ink: "#FFFFFF" },
};

/** 座位號 → 隊伍。座位號由 transport.takeSeat() 用 transaction 發，保證人數平均。 */
export function teamForSeat(seat: number, teamCount: number): TeamId {
  const n = Math.max(1, Math.min(teamCount, TEAM_IDS.length));
  return TEAM_IDS[((seat % n) + n) % n] as TeamId;
}
