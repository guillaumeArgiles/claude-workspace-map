import Phaser from "phaser";
import { layerDepth } from "../config/grid";
import { INTERACTION_RADIUS } from "./gameplayConstants";
import { t } from "../../i18n";

/** Up-render text @ DPR for crisp labels under pixelArt:true. */
const TEXT_RES = Math.max(2, Math.ceil(globalThis.devicePixelRatio || 1));

/**
 * Wooden notice-board placed in the garden next to the Professor. Acts as
 * the entry point to the Routines panel (RPGRoutinesUI).
 *
 * Rendered procedurally (no asset) : two wooden posts + a darker plank with
 * a chiseled border and a "⏰ Routines" title burned on. Positioned in world
 * coordinates so it collides cleanly with the existing collision system if
 * we ever add one (currently the player walks freely around it).
 *
 * Interaction is wired by MapScene : it stores the world position via
 * `centerPosition()` and PlayerController checks proximity against it
 * each frame, surfacing a "[Space] consulter les routines" prompt when
 * the player is in range.
 */
export class RoutinesPanelObject {
  /** Plank dimensions in world pixels. */
  private static readonly PLANK_W = 100;
  private static readonly PLANK_H = 56;
  /** Vertical drop from the centre to the ground for the supporting posts. */
  private static readonly POST_LENGTH = 28;

  /** World coordinates of the centre of the plank (top of the posts). */
  readonly cx: number;
  readonly cy: number;

  private graphics?: Phaser.GameObjects.Graphics;
  private titleText?: Phaser.GameObjects.Text;
  private interactPrompt?: Phaser.GameObjects.Text;

  constructor(
    private readonly scene: Phaser.Scene,
    cx: number,
    cy: number
  ) {
    this.cx = cx;
    this.cy = cy;
  }

  /** Build the visual. Call once after the scene's create() has run. */
  build(): void {
    const g = this.scene.add.graphics();
    g.setDepth(layerDepth.STATIC_PROPS + Math.round(this.cy));

    // Two supporting posts under the plank (darker wood).
    const postW = 8;
    const postOffsetX = RoutinesPanelObject.PLANK_W * 0.3;
    g.fillStyle(0x5b3a1f, 1);
    g.lineStyle(1, 0x2c1808, 0.9);
    for (const dx of [-postOffsetX, postOffsetX]) {
      const x = this.cx + dx - postW / 2;
      const y = this.cy + RoutinesPanelObject.PLANK_H / 2;
      g.fillRect(x, y, postW, RoutinesPanelObject.POST_LENGTH);
      g.strokeRect(x, y, postW, RoutinesPanelObject.POST_LENGTH);
    }

    // Plank — warm brown with a darker outline.
    const px = this.cx - RoutinesPanelObject.PLANK_W / 2;
    const py = this.cy - RoutinesPanelObject.PLANK_H / 2;
    g.fillStyle(0x8b5a2b, 1);
    g.lineStyle(2, 0x3b1f08, 1);
    g.fillRoundedRect(px, py, RoutinesPanelObject.PLANK_W, RoutinesPanelObject.PLANK_H, 4);
    g.strokeRoundedRect(px, py, RoutinesPanelObject.PLANK_W, RoutinesPanelObject.PLANK_H, 4);

    // Wood grain lines — a few subtle horizontal strokes.
    g.lineStyle(1, 0x6b4220, 0.55);
    for (let i = 1; i < 4; i++) {
      const gy = py + (RoutinesPanelObject.PLANK_H / 4) * i;
      g.lineBetween(px + 6, gy, px + RoutinesPanelObject.PLANK_W - 6, gy);
    }

    // Two corner nails.
    g.fillStyle(0xd1d5db, 1);
    g.lineStyle(1, 0x4b5563, 1);
    for (const cx of [px + 8, px + RoutinesPanelObject.PLANK_W - 8]) {
      for (const cy of [py + 6, py + RoutinesPanelObject.PLANK_H - 6]) {
        g.fillCircle(cx, cy, 1.5);
        g.strokeCircle(cx, cy, 1.5);
      }
    }

    this.graphics = g;

    // Title text on the plank — fits in two lines (clock emoji + "Routines").
    const title = t("routines.panel.title");
    const text = this.scene.add
      .text(this.cx, this.cy, title, {
        fontSize: "13px",
        fontStyle: "bold",
        color: "#fef3c7", // warm parchment yellow on dark wood
        align: "center",
        resolution: TEXT_RES,
      })
      .setOrigin(0.5, 0.5)
      .setDepth((g.depth ?? 0) + 1);
    this.titleText = text;

    // Floating "[Space] consulter les routines" prompt — hidden by default,
    // shown when the player is in interaction range.
    const promptLabel = t("dialogue.prompt", {
      label: t("routines.panel.interact"),
    });
    this.interactPrompt = this.scene.add
      .text(this.cx, this.cy - RoutinesPanelObject.PLANK_H / 2 - 14, promptLabel, {
        fontSize: "12px",
        color: "#ffffff",
        backgroundColor: "#000000cc",
        padding: { x: 6, y: 3 },
        resolution: TEXT_RES,
      })
      .setOrigin(0.5, 1)
      .setDepth(layerDepth.OVERLAYS)
      .setVisible(false);
  }

  /**
   * Updates the prompt visibility based on the player's position. Called
   * each frame from the scene's update(). Mirrors the "[Space] talk to …"
   * behaviour around NPCs.
   */
  checkProximity(playerX: number, playerY: number): boolean {
    const d = Math.hypot(this.cx - playerX, this.cy - playerY);
    const inRange = d < INTERACTION_RADIUS;
    if (this.interactPrompt) {
      this.interactPrompt.setVisible(inRange);
    }
    return inRange;
  }

  /** World-space position used by PlayerController for proximity detection. */
  centerPosition(): { x: number; y: number } {
    return { x: this.cx, y: this.cy };
  }

  destroy(): void {
    this.graphics?.destroy();
    this.titleText?.destroy();
    this.interactPrompt?.destroy();
  }
}
