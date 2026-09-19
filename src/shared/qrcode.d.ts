export interface QrMatrix {
  size: number;
  mod: boolean[][];
}
export function make(text: string): QrMatrix;
export function svg(
  text: string,
  opts?: { quiet?: number; dark?: string; light?: string },
): string;
export function capacity(version: number): number;
