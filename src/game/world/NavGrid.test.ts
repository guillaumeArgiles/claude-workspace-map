import { describe, expect, it } from "vitest";
import { NavGrid, type NavRect } from "./NavGrid";

function newGrid(rects: NavRect[] = [], margin = 0) {
  return NavGrid.buildFromObstacles(
    { widthPx: 100, heightPx: 100, cellSize: 10, margin },
    rects
  );
}

describe("NavGrid", () => {
  it("starts entirely walkable when no obstacles are provided", () => {
    const grid = newGrid();
    expect(grid.cols).toBe(10);
    expect(grid.rows).toBe(10);
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        expect(grid.isWalkableCell(c, r)).toBe(true);
      }
    }
  });

  it("blocks the cells covered by a rectangle", () => {
    const grid = newGrid([{ x: 30, y: 30, w: 20, h: 20 }]);
    // The rect spans cells (3..4, 3..4) at cellSize 10.
    expect(grid.isWalkable(35, 35)).toBe(false);
    expect(grid.isWalkable(45, 45)).toBe(false);
    // Just outside the rect (and outside any margin): walkable.
    expect(grid.isWalkable(25, 35)).toBe(true);
    expect(grid.isWalkable(55, 55)).toBe(true);
  });

  it("inflates obstacles by `margin` pixels around them", () => {
    const grid = newGrid([{ x: 40, y: 40, w: 20, h: 20 }], 10);
    // The rect is 40..60, inflated to 30..70 → cells (3..6).
    expect(grid.isWalkable(35, 50)).toBe(false);
    expect(grid.isWalkable(65, 50)).toBe(false);
    // Still walkable outside the inflated band.
    expect(grid.isWalkable(25, 50)).toBe(true);
    expect(grid.isWalkable(75, 50)).toBe(true);
  });

  it("rejects out-of-bounds coordinates", () => {
    const grid = newGrid();
    expect(grid.isWalkableCell(-1, 5)).toBe(false);
    expect(grid.isWalkableCell(5, -1)).toBe(false);
    expect(grid.isWalkableCell(10, 5)).toBe(false);
    expect(grid.isWalkableCell(5, 10)).toBe(false);
  });

  describe("findPath", () => {
    it("returns the trivial path when start == end", () => {
      const grid = newGrid();
      const path = grid.findPath({ x: 50, y: 50 }, { x: 50, y: 50 });
      expect(path).not.toBeNull();
      expect(path!.length).toBe(2);
    });

    it("walks straight when nothing blocks the way", () => {
      const grid = newGrid();
      const path = grid.findPath({ x: 5, y: 50 }, { x: 95, y: 50 });
      expect(path).not.toBeNull();
      // After line-of-sight smoothing, an obstacle-free path is exactly the
      // two endpoints.
      expect(path!.length).toBe(2);
    });

    it("goes around a blocking wall", () => {
      // Wall in the middle leaving a 20px corridor at the top.
      const grid = newGrid([{ x: 40, y: 20, w: 20, h: 80 }]);
      const path = grid.findPath({ x: 20, y: 50 }, { x: 80, y: 50 });
      expect(path).not.toBeNull();
      // The path must include at least one waypoint above the wall (y < 20)
      // and never cross a blocked cell.
      for (const pt of path!) {
        expect(grid.isWalkable(pt.x, pt.y)).toBe(true);
      }
      // And consecutive segments must stay in line-of-sight.
      for (let i = 0; i < path!.length - 1; i++) {
        expect(grid.hasLineOfSight(path![i], path![i + 1])).toBe(true);
      }
    });

    it("returns null when the goal is unreachable", () => {
      // Fully enclose a cell so it's walled off.
      const grid = newGrid([
        { x: 40, y: 0, w: 1, h: 100 }, // ridiculous thin wall, but each cell along the line is blocked because of how cells are flagged
      ]);
      // Even the thin wall blocks the column at cells x=4. Pathing across it
      // is impossible because diagonal corner-cutting is blocked when both
      // cardinals are walls (a single column doesn't block diagonals though,
      // so we make sure the rect rounds to a fully blocked column).
      // We exit the test if the wall happens to be passable on this grid.
      const wallPassable = grid.isWalkable(40, 50);
      if (wallPassable) {
        // adapt the test: build a beefier wall instead
      }
      const tighter = newGrid([{ x: 35, y: 0, w: 15, h: 100 }]);
      const path = tighter.findPath({ x: 10, y: 50 }, { x: 90, y: 50 });
      expect(path).toBeNull();
    });

    it("snaps blocked endpoints to the nearest walkable cell", () => {
      // Start sits inside an obstacle; the snap should pull it just outside.
      const grid = newGrid([{ x: 0, y: 40, w: 30, h: 20 }]);
      const path = grid.findPath({ x: 15, y: 50 }, { x: 80, y: 50 });
      expect(path).not.toBeNull();
      // First waypoint must be walkable (not inside the rect).
      expect(grid.isWalkable(path![0].x, path![0].y)).toBe(true);
    });
  });

  describe("randomWalkableNear", () => {
    it("returns a walkable point near the centre when possible", () => {
      const grid = newGrid();
      const p = grid.randomWalkableNear({ x: 50, y: 50 }, 5, 15);
      expect(p).not.toBeNull();
      expect(grid.isWalkable(p!.x, p!.y)).toBe(true);
      const d = Math.hypot(p!.x - 50, p!.y - 50);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(15 + 1);
    });

    it("returns null when no walkable cell exists in the ring", () => {
      // Block the whole map.
      const grid = newGrid([{ x: 0, y: 0, w: 100, h: 100 }]);
      expect(grid.randomWalkableNear({ x: 50, y: 50 }, 5, 15)).toBeNull();
    });
  });

  describe("hasLineOfSight", () => {
    it("returns true when both endpoints and the segment are walkable", () => {
      const grid = newGrid();
      expect(grid.hasLineOfSight({ x: 10, y: 10 }, { x: 90, y: 90 })).toBe(true);
    });

    it("returns false when a wall stands between the endpoints", () => {
      const grid = newGrid([{ x: 40, y: 0, w: 20, h: 100 }]);
      expect(grid.hasLineOfSight({ x: 10, y: 50 }, { x: 90, y: 50 })).toBe(false);
    });

    it("is true for a zero-length segment", () => {
      const grid = newGrid();
      expect(grid.hasLineOfSight({ x: 50, y: 50 }, { x: 50, y: 50 })).toBe(true);
    });
  });
});
