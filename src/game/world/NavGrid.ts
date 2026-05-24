/**
 * Grid-based navigation for the map.
 *
 * Built once at scene start from the static collision rectangles, inflated
 * by a `margin` so the *centre* of an agent stays away from walls. Supports:
 *   - `isWalkable(x, y)` for O(1) clearance checks
 *   - `findPath(start, end)` — A* 8-direction with Chebyshev heuristic and
 *     line-of-sight smoothing
 *   - `randomWalkableNear(center, minR, maxR)` — picks a walkable wander
 *     target around a home position
 *
 * Pure logic, no Phaser dependency, so it can be unit-tested in node.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface NavRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface MinHeapItem {
  idx: number;
  f: number;
}

/**
 * Tiny binary min-heap keyed on `.f`. Plenty fast enough for the ~10k cells
 * we care about; avoids pulling in a dependency.
 */
class MinHeap {
  private data: MinHeapItem[] = [];

  get size(): number {
    return this.data.length;
  }

  push(item: MinHeapItem): void {
    this.data.push(item);
    this.siftUp(this.data.length - 1);
  }

  pop(): MinHeapItem | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[parent].f <= this.data[i].f) break;
      [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.data.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.data[l].f < this.data[smallest].f) smallest = l;
      if (r < n && this.data[r].f < this.data[smallest].f) smallest = r;
      if (smallest === i) return;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** 0 = walkable, 1 = blocked. Row-major (idx = row * cols + col). */
  private readonly blocked: Uint8Array;

  constructor(opts: { widthPx: number; heightPx: number; cellSize: number }) {
    this.widthPx = opts.widthPx;
    this.heightPx = opts.heightPx;
    this.cellSize = opts.cellSize;
    this.cols = Math.ceil(opts.widthPx / opts.cellSize);
    this.rows = Math.ceil(opts.heightPx / opts.cellSize);
    this.blocked = new Uint8Array(this.cols * this.rows);
  }

  /**
   * Build a nav-grid from a list of collision rectangles, inflated by
   * `margin` pixels so the *centre* of an agent of half-width ≈ `margin`
   * never gets stuck against an obstacle body.
   */
  static buildFromObstacles(
    opts: { widthPx: number; heightPx: number; cellSize: number; margin: number },
    rects: NavRect[]
  ): NavGrid {
    const grid = new NavGrid(opts);
    for (const rect of rects) {
      grid.markRectBlocked(
        rect.x - opts.margin,
        rect.y - opts.margin,
        rect.w + opts.margin * 2,
        rect.h + opts.margin * 2
      );
    }
    return grid;
  }

  // ----- Cell lookups -----

  isWalkableCell(col: number, row: number): boolean {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return false;
    return this.blocked[row * this.cols + col] === 0;
  }

  isWalkable(x: number, y: number): boolean {
    return this.isWalkableCell(this.colOf(x), this.rowOf(y));
  }

  colOf(x: number): number {
    return Math.floor(x / this.cellSize);
  }

  rowOf(y: number): number {
    return Math.floor(y / this.cellSize);
  }

  /** World-space centre of a cell. */
  centerOf(col: number, row: number): Vec2 {
    return {
      x: col * this.cellSize + this.cellSize / 2,
      y: row * this.cellSize + this.cellSize / 2,
    };
  }

  /**
   * If `(x, y)` is blocked, return the closest walkable cell centre within
   * `maxRingRadius` rings (spiral search). Returns the original point if it
   * was already walkable.
   */
  snapToWalkable(x: number, y: number, maxRingRadius = 8): Vec2 | null {
    const sc = this.colOf(x);
    const sr = this.rowOf(y);
    if (this.isWalkableCell(sc, sr)) return { x, y };
    for (let radius = 1; radius <= maxRingRadius; radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue; // ring perimeter only
          const c = sc + dc;
          const r = sr + dr;
          if (this.isWalkableCell(c, r)) return this.centerOf(c, r);
        }
      }
    }
    return null;
  }

  // ----- A* path search -----

  /**
   * Find a walkable path from `start` to `end`, returning a smoothed list
   * of world-space waypoints. Returns `null` when the end is unreachable.
   */
  findPath(start: Vec2, end: Vec2): Vec2[] | null {
    const s = this.snapToWalkable(start.x, start.y);
    const e = this.snapToWalkable(end.x, end.y);
    if (!s || !e) return null;

    const sc = this.colOf(s.x);
    const sr = this.rowOf(s.y);
    const ec = this.colOf(e.x);
    const er = this.rowOf(e.y);
    const startIdx = sr * this.cols + sc;
    const endIdx = er * this.cols + ec;

    if (startIdx === endIdx) return [s, e];

    const open = new MinHeap();
    const cameFrom = new Map<number, number>();
    const gScore = new Map<number, number>();
    open.push({ idx: startIdx, f: 0 });
    gScore.set(startIdx, 0);

    const STRAIGHT = 10; // movement cost: 10 for cardinal, 14 for diagonal (≈√2)
    const DIAGONAL = 14;
    const neighbours: Array<[number, number, number]> = [
      [-1, 0, STRAIGHT],
      [1, 0, STRAIGHT],
      [0, -1, STRAIGHT],
      [0, 1, STRAIGHT],
      [-1, -1, DIAGONAL],
      [1, -1, DIAGONAL],
      [-1, 1, DIAGONAL],
      [1, 1, DIAGONAL],
    ];

    while (open.size > 0) {
      const current = open.pop()!.idx;
      if (current === endIdx) {
        return this.smoothCellPath(this.reconstructCellPath(cameFrom, current));
      }
      const cc = current % this.cols;
      const cr = (current - cc) / this.cols;
      for (const [dc, dr, cost] of neighbours) {
        const nc = cc + dc;
        const nr = cr + dr;
        if (!this.isWalkableCell(nc, nr)) continue;
        // Prevent diagonal corner-cutting through corners.
        if (dc !== 0 && dr !== 0) {
          if (!this.isWalkableCell(cc + dc, cr)) continue;
          if (!this.isWalkableCell(cc, cr + dr)) continue;
        }
        const nIdx = nr * this.cols + nc;
        const tentativeG = (gScore.get(current) ?? Infinity) + cost;
        if (tentativeG < (gScore.get(nIdx) ?? Infinity)) {
          cameFrom.set(nIdx, current);
          gScore.set(nIdx, tentativeG);
          // Chebyshev heuristic, scaled to match cost units.
          const h =
            STRAIGHT *
            Math.max(Math.abs(nc - ec), Math.abs(nr - er)) +
            (DIAGONAL - 2 * STRAIGHT) *
              Math.min(Math.abs(nc - ec), Math.abs(nr - er));
          open.push({ idx: nIdx, f: tentativeG + h });
        }
      }
    }
    return null;
  }

  private reconstructCellPath(
    cameFrom: Map<number, number>,
    endIdx: number
  ): Vec2[] {
    const path: Vec2[] = [];
    let cur: number | undefined = endIdx;
    while (cur !== undefined) {
      const c = cur % this.cols;
      const r = (cur - c) / this.cols;
      path.push(this.centerOf(c, r));
      cur = cameFrom.get(cur);
    }
    return path.reverse();
  }

  /**
   * Line-of-sight smoothing: replace consecutive waypoints with a direct
   * segment when nothing blocks the way. Cuts wiggle from the raw grid path.
   */
  private smoothCellPath(path: Vec2[]): Vec2[] {
    if (path.length < 3) return path;
    const out: Vec2[] = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
      let j = path.length - 1;
      while (j > i + 1 && !this.hasLineOfSight(path[i], path[j])) j--;
      out.push(path[j]);
      i = j;
    }
    return out;
  }

  /**
   * Sample along the segment `a → b` and check every cell crossed is walkable.
   * Step size = half-cell so we never skip a cell diagonally.
   */
  hasLineOfSight(a: Vec2, b: Vec2): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return true;
    const steps = Math.max(1, Math.ceil((dist * 2) / this.cellSize));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.isWalkable(a.x + dx * t, a.y + dy * t)) return false;
    }
    return true;
  }

  // ----- Wander helpers -----

  /**
   * Try up to `attempts` random points around `center` in the ring
   * [minRadius, maxRadius] and return the first one that lands on a walkable
   * cell. Returns `null` if none found.
   */
  randomWalkableNear(
    center: Vec2,
    minRadius: number,
    maxRadius: number,
    attempts = 24
  ): Vec2 | null {
    for (let i = 0; i < attempts; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = minRadius + Math.random() * (maxRadius - minRadius);
      const x = center.x + Math.cos(angle) * radius;
      const y = center.y + Math.sin(angle) * radius;
      if (this.isWalkable(x, y)) return { x, y };
    }
    return null;
  }

  // ----- Debug introspection -----

  forEachBlockedCell(cb: (col: number, row: number) => void): void {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.blocked[r * this.cols + c] === 1) cb(c, r);
      }
    }
  }

  // ----- Internal -----

  private markRectBlocked(x: number, y: number, w: number, h: number): void {
    const c0 = Math.max(0, Math.floor(x / this.cellSize));
    // Use ceil-1 so a rect whose right edge lands exactly on a cell boundary
    // (e.g. x+w = 50 with cellSize 10) doesn't bleed into the next cell.
    const c1 = Math.min(this.cols - 1, Math.ceil((x + w) / this.cellSize) - 1);
    const r0 = Math.max(0, Math.floor(y / this.cellSize));
    const r1 = Math.min(this.rows - 1, Math.ceil((y + h) / this.cellSize) - 1);
    if (c1 < c0 || r1 < r0) return;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        this.blocked[r * this.cols + c] = 1;
      }
    }
  }
}
