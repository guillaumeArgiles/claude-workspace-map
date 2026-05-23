export const GRID = {
  cols: 20,
  rows: 12,
  cellSize: 72,
  width: 20 * 72,
  height: 12 * 72,
} as const;

export const layerDepth = {
  GROUND: 0,
  PATH: 1000,
  FLOOR: 2000,
  PATH_DECOR: 2500,
  WALLS: 3000,
  STATIC_PROPS: 4000,
  DECOR: 5000,
  AGENTS: 6000,
  OVERLAYS: 7000,
  UI: 9000,
} as const;

export type LayerName = keyof typeof layerDepth;

export interface CellSpan {
  cols: number;
  rows: number;
}

const COL_LETTERS = "ABCDEFGHIJKLMNOPQRST";

export function parseCell(cell: string): { col: number; row: number } {
  const m = cell.match(/^([A-T])(\d{1,2})$/);
  if (!m) throw new Error(`Invalid cell: ${cell}`);
  return {
    col: COL_LETTERS.indexOf(m[1]),
    row: Number(m[2]) - 1,
  };
}

export function cellToTopLeftPixel(cell: string): { x: number; y: number } {
  const { col, row } = parseCell(cell);
  return { x: col * GRID.cellSize, y: row * GRID.cellSize };
}

export function cellToCenterPixel(
  cell: string,
  span: CellSpan = { cols: 1, rows: 1 }
): { x: number; y: number } {
  const { col, row } = parseCell(cell);
  return {
    x: col * GRID.cellSize + (span.cols * GRID.cellSize) / 2,
    y: row * GRID.cellSize + (span.rows * GRID.cellSize) / 2,
  };
}

export function expandCellRange(from: string, to: string): string[] {
  const a = parseCell(from);
  const b = parseCell(to);
  const cells: string[] = [];
  const c0 = Math.min(a.col, b.col);
  const c1 = Math.max(a.col, b.col);
  const r0 = Math.min(a.row, b.row);
  const r1 = Math.max(a.row, b.row);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      cells.push(`${COL_LETTERS[c]}${r + 1}`);
    }
  }
  return cells;
}
