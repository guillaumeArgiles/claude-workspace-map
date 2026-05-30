import Phaser from "phaser";
import {
  PLAYER_W,
  PLAYER_H,
  TARGET_CHAR_HEIGHT,
  TARGET_NATIVE_HEIGHT,
} from "../world/gameplayConstants";
import type { Direction } from "./types";

/**
 * Builds walk + idle animations from whatever sprite asset is available, then
 * scales the resulting sprite so every character ends up the same on-screen
 * size. Knows nothing about NPC state, AI, or overlays — only pixels.
 *
 * Why a separate class: sprite loading was ~250 lines of canvas-pixel-pushing
 * (chroma-key, flood-fill, downsample, sheet detection) that drowned the
 * NpcManager's actual job (lifecycle + wander + status overlays). Extracted
 * in PT.5 so both files stay below the 400-line target.
 */
export class CharacterSpriteFactory {
  /** IDs of characters whose `right` direction is the flipped `left` sprite. */
  private readonly charNeedsRightFlip = new Set<string>();

  constructor(private readonly scene: Phaser.Scene) {}

  needsRightFlip(id: string): boolean {
    return this.charNeedsRightFlip.has(id);
  }

  /**
   * Build walk + idle animations for a character (player or NPC) from whatever
   * sprite file is available. Returns the texture key the sprite should start
   * with. Format detection:
   *   - 3:4 aspect ratio   → RPG Maker 3×4 sheet, 4 distinct directions.
   *   - other (3:1, 1:1…)  → single-row sheet, flip horizontally for right.
   *   - no real sprite     → 2-frame programmatic placeholder.
   */
  buildCharacterAnimations(
    id: string,
    bodyHex: string,
    headHex: string,
    spriteSource?: string
  ): string {
    const source = spriteSource ?? id;
    const imageKey = `${source}_image`;

    if (this.scene.textures.exists(imageKey)) {
      const img = this.scene.textures.get(imageKey).getSourceImage() as
        | HTMLImageElement
        | HTMLCanvasElement;
      const ratio = img.width / img.height;

      // RPG Maker format: 3 cols × 4 rows. Rows = down/left/right/up.
      if (Math.abs(ratio - 3 / 4) < 0.05 && img.width % 3 === 0 && img.height % 4 === 0) {
        const sheetKey = `${source}_sheet`;
        if (!this.scene.textures.exists(sheetKey)) {
          this.scene.textures.addSpriteSheet(sheetKey, img as HTMLImageElement, {
            frameWidth: img.width / 3,
            frameHeight: img.height / 4,
          });
        }
        const rowFor: Record<Direction, number> = { down: 0, left: 1, right: 2, up: 3 };
        for (const dir of ["down", "left", "right", "up"] as Direction[]) {
          const r = rowFor[dir];
          const base = r * 3;
          const walkKey = `${id}_walk_${dir}`;
          const idleKey = `${id}_idle_${dir}`;
          if (!this.scene.anims.exists(walkKey)) {
            this.scene.anims.create({
              key: walkKey,
              frames: [
                { key: sheetKey, frame: base + 1 },
                { key: sheetKey, frame: base + 0 },
                { key: sheetKey, frame: base + 1 },
                { key: sheetKey, frame: base + 2 },
              ],
              frameRate: 6,
              repeat: -1,
            });
          }
          if (!this.scene.anims.exists(idleKey)) {
            this.scene.anims.create({
              key: idleKey,
              frames: [{ key: sheetKey, frame: base + 1 }],
              frameRate: 1,
            });
          }
        }
        return sheetKey;
      }

      // Legacy single-row 3-frame sheet (front view only): flip for right.
      this.ensureCleanedTexture(imageKey);
      const cleanedImg = this.scene.textures.get(imageKey).getSourceImage() as HTMLImageElement;
      const sheetKey = `${source}_sheet`;
      if (!this.scene.textures.exists(sheetKey)) {
        this.scene.textures.addSpriteSheet(sheetKey, cleanedImg, {
          frameWidth: Math.floor(cleanedImg.width / 3),
          frameHeight: cleanedImg.height,
        });
      }
      for (const dir of ["down", "left", "right", "up"] as Direction[]) {
        const walkKey = `${id}_walk_${dir}`;
        const idleKey = `${id}_idle_${dir}`;
        if (!this.scene.anims.exists(walkKey)) {
          this.scene.anims.create({
            key: walkKey,
            frames: this.scene.anims.generateFrameNumbers(sheetKey, { start: 0, end: 2 }),
            frameRate: 6,
            repeat: -1,
          });
        }
        if (!this.scene.anims.exists(idleKey)) {
          this.scene.anims.create({
            key: idleKey,
            frames: [{ key: sheetKey, frame: 0 }],
            frameRate: 1,
          });
        }
      }
      this.charNeedsRightFlip.add(id);
      return sheetKey;
    }

    // Programmatic placeholder fallback.
    const body = Phaser.Display.Color.HexStringToColor(bodyHex).color;
    const head = Phaser.Display.Color.HexStringToColor(headHex).color;
    const f0 = `${id}_f0`;
    const f1 = `${id}_f1`;
    if (!this.scene.textures.exists(f0)) this.drawPlaceholderFrame(f0, body, head, 0);
    if (!this.scene.textures.exists(f1)) this.drawPlaceholderFrame(f1, body, head, 1);

    if (!this.scene.anims.exists(`${id}_walk`)) {
      this.scene.anims.create({
        key: `${id}_walk`,
        frames: [{ key: f0 }, { key: f1 }],
        frameRate: 6,
        repeat: -1,
      });
    }
    if (!this.scene.anims.exists(`${id}_idle`)) {
      this.scene.anims.create({
        key: `${id}_idle`,
        frames: [{ key: f0 }],
        frameRate: 1,
      });
    }
    return f0;
  }

  /** Scale a sprite to TARGET_CHAR_HEIGHT only if it's backed by a real spritesheet. */
  scaleCharacterIfReal(sprite: Phaser.Physics.Arcade.Sprite, initialKey: string): void {
    if (initialKey.endsWith("_f0")) return; // programmatic placeholder, leave native size
    const naturalH = sprite.height;
    if (naturalH <= 0) return;
    const scale = TARGET_CHAR_HEIGHT / naturalH;
    sprite.setScale(scale);
  }

  /**
   * Make the AI-generated "fake transparent" background of an image actually
   * transparent, then downsample to TARGET_NATIVE_HEIGHT for crisp pixel art.
   * Idempotent — flags textures it has already processed.
   */
  private ensureCleanedTexture(imageKey: string): void {
    if (!this.scene.textures.exists(imageKey)) return;
    const tex = this.scene.textures.get(imageKey);
    if ((tex as unknown as { __cleaned?: boolean }).__cleaned) return;

    const source = tex.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    const w = source.width;
    const h = source.height;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(source, 0, 0);

    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    // Pass 1: chroma-key magenta (R high, G low, B high).
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] > 200) {
        data[i + 3] = 0;
      }
    }

    // Pass 2: checkerboard flood-fill (legacy AI sprites).
    if (data[3] > 0) {
      const c1: [number, number, number] = [data[0], data[1], data[2]];
      let c2: [number, number, number] = c1;
      for (let x = 1; x < Math.min(w, 64); x++) {
        const i = x * 4;
        if (Math.abs(data[i] - c1[0]) > 12) {
          c2 = [data[i], data[i + 1], data[i + 2]];
          break;
        }
      }
      const TOL = 10;
      const isBg = (r: number, g: number, b: number) =>
        (Math.abs(r - c1[0]) <= TOL && Math.abs(g - c1[1]) <= TOL && Math.abs(b - c1[2]) <= TOL) ||
        (Math.abs(r - c2[0]) <= TOL && Math.abs(g - c2[1]) <= TOL && Math.abs(b - c2[2]) <= TOL);
      const visited = new Uint8Array(w * h);
      const stack: number[] = [];
      const tryPush = (x: number, y: number) => {
        if (x < 0 || x >= w || y < 0 || y >= h) return;
        const idx = y * w + x;
        if (visited[idx]) return;
        visited[idx] = 1;
        const p = idx * 4;
        if (data[p + 3] > 0 && isBg(data[p], data[p + 1], data[p + 2])) {
          data[p + 3] = 0;
          stack.push(idx);
        }
      };
      tryPush(0, 0);
      tryPush(w - 1, 0);
      tryPush(0, h - 1);
      tryPush(w - 1, h - 1);
      while (stack.length) {
        const idx = stack.pop()!;
        const x = idx % w;
        const y = (idx - x) / w;
        tryPush(x - 1, y);
        tryPush(x + 1, y);
        tryPush(x, y - 1);
        tryPush(x, y + 1);
      }
    }

    ctx.putImageData(imageData, 0, 0);

    let finalCanvas: HTMLCanvasElement = canvas;
    if (h > TARGET_NATIVE_HEIGHT * 1.5) {
      const scale = TARGET_NATIVE_HEIGHT / h;
      const small = document.createElement("canvas");
      small.width = Math.max(1, Math.round(w * scale));
      small.height = Math.max(1, Math.round(h * scale));
      const sctx = small.getContext("2d")!;
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = "high";
      sctx.drawImage(canvas, 0, 0, small.width, small.height);
      finalCanvas = small;
    }

    this.scene.textures.remove(imageKey);
    this.scene.textures.addCanvas(imageKey, finalCanvas);
    (this.scene.textures.get(imageKey) as unknown as { __cleaned?: boolean }).__cleaned = true;
  }

  private drawPlaceholderFrame(
    key: string,
    body: number,
    head: number,
    frame: 0 | 1
  ): void {
    const W = PLAYER_W;
    const H = PLAYER_H;
    const PANTS = 0x1a202c;
    const g = this.scene.add.graphics();
    g.fillStyle(body, 1);
    g.fillRect(2, 14, W - 4, H - 16 - 4);
    g.fillStyle(head, 1);
    g.fillRect(6, 2, W - 12, 12);
    g.fillStyle(PANTS, 1);
    if (frame === 0) {
      g.fillRect(7, 26, 4, 6);
      g.fillRect(13, 26, 4, 6);
    } else {
      g.fillRect(5, 25, 4, 7);
      g.fillRect(15, 25, 4, 7);
    }
    g.lineStyle(1, 0x111111, 1);
    g.strokeRect(2, 14, W - 4, H - 16 - 4);
    g.strokeRect(6, 2, W - 12, 12);
    g.generateTexture(key, W, H);
    g.destroy();
  }
}
