import Phaser from "phaser";
import { GRID, layerDepth } from "../config/grid";

export interface CollisionRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

export interface CollisionsFile {
  version: string;
  description?: string;
  rects: CollisionRect[];
}

interface DrawnRect {
  rect: CollisionRect;
  graphic: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  zone: Phaser.GameObjects.Zone;
}

/**
 * Loads the static collision rectangles from collisions.json and, in debug
 * mode, exposes the drag-to-draw tool that lets you sketch new ones on the
 * map and auto-copy them as JSON.
 */
export class CollisionLayer {
  /** The Arcade Physics static group everything collides against. */
  obstacles!: Phaser.Physics.Arcade.StaticGroup;

  // Drawing-tool state (debug only)
  private drawStart?: { x: number; y: number };
  private drawingPreview?: Phaser.GameObjects.Graphics;
  private drawnRects: DrawnRect[] = [];
  private mouseLabel?: Phaser.GameObjects.Text;
  private helpLabel?: Phaser.GameObjects.Text;

  constructor(private readonly scene: Phaser.Scene) {}

  /** Build static bodies from the loaded JSON. Call once in scene.create(). */
  load(file: CollisionsFile, opts: { debug: boolean }): void {
    this.obstacles = this.scene.physics.add.staticGroup();
    for (const rect of file.rects) {
      this.addObstacle(rect);
      if (opts.debug) this.drawDebugRect(rect);
    }
  }

  /** ?debug mode: show mouse coords + help banner + arm the drawing tool. */
  enableDebug(): void {
    this.scene.physics.world.drawDebug = true;
    this.scene.physics.world.debugGraphic = this.scene.add
      .graphics()
      .setDepth(layerDepth.UI - 1);

    this.mouseLabel = this.scene.add
      .text(8, GRID.height - 22, "x: -, y: -", {
        fontSize: "12px",
        color: "#ffffff",
        backgroundColor: "#000000aa",
        padding: { x: 6, y: 3 },
      })
      .setScrollFactor(0)
      .setDepth(layerDepth.UI + 1);

    this.helpLabel = this.scene.add
      .text(8, 8, "DEBUG · drag = draw rect (auto-copy) · X = undo · R = reset", {
        fontSize: "12px",
        color: "#ffffff",
        backgroundColor: "#000000aa",
        padding: { x: 6, y: 3 },
      })
      .setScrollFactor(0)
      .setDepth(layerDepth.UI + 1);

    this.scene.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      this.mouseLabel?.setText(
        `x: ${Math.round(pointer.worldX)}, y: ${Math.round(pointer.worldY)}`
      );
    });

    this.enableDrawingTool();
  }

  // ----- Static body creation -----

  private addObstacle(rect: CollisionRect): Phaser.GameObjects.Zone {
    const zone = this.scene.add.zone(
      rect.x + rect.w / 2,
      rect.y + rect.h / 2,
      rect.w,
      rect.h
    );
    this.scene.physics.add.existing(zone, true);
    this.obstacles.add(zone);
    return zone;
  }

  private drawDebugRect(rect: CollisionRect): void {
    const g = this.scene.add.graphics();
    g.fillStyle(0xff3344, 0.25);
    g.fillRect(rect.x, rect.y, rect.w, rect.h);
    g.lineStyle(2, 0xff3344, 0.9);
    g.strokeRect(rect.x, rect.y, rect.w, rect.h);
    g.setDepth(layerDepth.UI - 1);

    const label = rect.label ?? rect.id;
    this.scene.add
      .text(
        rect.x + 6,
        rect.y + 6,
        `${label}\n${rect.x},${rect.y}  ${rect.w}×${rect.h}`,
        {
          fontSize: "11px",
          color: "#ffffff",
          backgroundColor: "#00000088",
        }
      )
      .setDepth(layerDepth.UI);
  }

  // ----- Drawing tool -----

  private enableDrawingTool(): void {
    this.scene.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.drawStart = { x: Math.round(p.worldX), y: Math.round(p.worldY) };
      this.drawingPreview = this.scene.add.graphics().setDepth(layerDepth.UI - 1);
    });

    this.scene.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.drawStart || !this.drawingPreview) return;
      const r = this.rectFromDrag(p);
      this.drawingPreview.clear();
      this.drawingPreview.fillStyle(0xffff00, 0.3);
      this.drawingPreview.fillRect(r.x, r.y, r.w, r.h);
      this.drawingPreview.lineStyle(2, 0xffff00, 1);
      this.drawingPreview.strokeRect(r.x, r.y, r.w, r.h);
    });

    this.scene.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (!this.drawStart) return;
      const r = this.rectFromDrag(p);
      this.drawingPreview?.destroy();
      this.drawingPreview = undefined;
      this.drawStart = undefined;
      if (r.w < 6 || r.h < 6) return;

      const id = `new_${this.drawnRects.length + 1}`;
      const rect: CollisionRect = { id, ...r, label: id };
      this.commitDrawnRect(rect);
      this.copyDrawnAsJson();
    });

    this.scene.input.keyboard!.on("keydown-X", () => this.undoLastDrawn());
    this.scene.input.keyboard!.on("keydown-R", () => this.resetDrawn());
  }

  private rectFromDrag(p: Phaser.Input.Pointer): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    const x1 = this.drawStart!.x;
    const y1 = this.drawStart!.y;
    const x2 = Math.round(p.worldX);
    const y2 = Math.round(p.worldY);
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
    };
  }

  private commitDrawnRect(rect: CollisionRect): void {
    const g = this.scene.add.graphics().setDepth(layerDepth.UI - 1);
    g.fillStyle(0xffff00, 0.25);
    g.fillRect(rect.x, rect.y, rect.w, rect.h);
    g.lineStyle(2, 0xffaa00, 1);
    g.strokeRect(rect.x, rect.y, rect.w, rect.h);

    const label = this.scene.add
      .text(
        rect.x + 4,
        rect.y + 4,
        `${rect.id}\n${rect.x},${rect.y} ${rect.w}×${rect.h}`,
        {
          fontSize: "11px",
          color: "#222",
          backgroundColor: "#ffff00cc",
          padding: { x: 3, y: 1 },
        }
      )
      .setDepth(layerDepth.UI);

    const zone = this.addObstacle(rect);
    this.drawnRects.push({ rect, graphic: g, label, zone });
    console.log("[debug] new rect:", JSON.stringify(rect));
  }

  private copyDrawnAsJson(): void {
    if (this.drawnRects.length === 0) return;
    const lines = this.drawnRects.map(
      ({ rect: r }) =>
        `    { "id": "${r.id}", "x": ${r.x}, "y": ${r.y}, "w": ${r.w}, "h": ${r.h}, "label": "${r.label}" }`
    );
    const json = lines.join(",\n");
    navigator.clipboard.writeText(json).then(
      () => {
        console.log(
          `[debug] copied ${this.drawnRects.length} rect(s) to clipboard:\n${json}`
        );
        this.helpLabel?.setText(
          `Copied ${this.drawnRects.length} rect(s) — paste into collisions.json`
        );
        this.scene.time.delayedCall(2000, () => this.resetHelpLabel());
      },
      () => {
        console.log("[debug] clipboard failed, JSON in console:\n" + json);
      }
    );
  }

  private undoLastDrawn(): void {
    const last = this.drawnRects.pop();
    if (!last) return;
    last.graphic.destroy();
    last.label.destroy();
    last.zone.destroy();
  }

  private resetDrawn(): void {
    while (this.drawnRects.length) this.undoLastDrawn();
  }

  private resetHelpLabel(): void {
    this.helpLabel?.setText(
      "DEBUG · drag = draw rect (auto-copy) · X = undo · R = reset"
    );
  }
}
