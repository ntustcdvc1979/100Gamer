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
  /** 這一隊是哪一種皮克敏（活動主視覺 group.png 的分組）。 */
  pikmin: string;
  /** 主視覺上的「XX力 MAX」 */
  trait: string;
  /** 頭上長的是葉子還是花 —— 投影幕與手機畫皮克敏時用 */
  sprout: "leaf" | "flower";
}

/*
 * 顏色照主視覺 group.png 挑的：紅、黃、藍皮克敏都是飽和的原色，
 * 白皮克敏是白身紅眼。之前的土黃偏暗、水藍偏淺，放在卡通畫面上會顯得髒。
 */
export const TEAMS: Record<TeamId, TeamDef> = {
  A: { id: "A", name: "火象", color: "#E53935", ink: "#FFFFFF", pikmin: "紅皮克敏", trait: "行動力", sprout: "leaf" },
  B: { id: "B", name: "水象", color: "#2D6CDF", ink: "#FFFFFF", pikmin: "藍皮克敏", trait: "療癒力", sprout: "leaf" },
  C: { id: "C", name: "土象", color: "#F4C12E", ink: "#4A3200", pikmin: "黃皮克敏", trait: "可靠力", sprout: "flower" },
  D: { id: "D", name: "風象", color: "#FFFFFF", ink: "#2A2A30", light: true, pikmin: "白皮克敏", trait: "創意力", sprout: "flower" },
};

/**
 * 畫面上排隊伍的順序，照主視覺由左到右：火、土、水、風。
 * TEAM_IDS 的順序不能動（熱血拔河的對戰組合、存下來的分數都認它），
 * 所以另外給一個「顯示用」的順序。
 */
export const DISPLAY_ORDER: TeamId[] = ["A", "C", "B", "D"];

/** 座位號 → 隊伍。玩家自己選隊之後只剩假玩家在用。 */
export function teamForSeat(seat: number, teamCount: number): TeamId {
  const n = Math.max(1, Math.min(teamCount, TEAM_IDS.length));
  return TEAM_IDS[((seat % n) + n) % n] as TeamId;
}
