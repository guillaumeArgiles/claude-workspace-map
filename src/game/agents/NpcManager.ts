import Phaser from "phaser";
import { layerDepth } from "../config/grid";
import type { AgentStatus } from "../../../shared/agent-types";
import { STATUS_COLOR_HEX } from "../../../shared/agent-ui";
import {
  HITBOX_W_RATIO,
  HITBOX_H_RATIO,
  NPC_PAUSE_MIN,
  NPC_PAUSE_MAX,
  NPC_REACH_DIST,
  NPC_SPEED,
  NPC_STUCK_TIMEOUT,
  NPC_WANDER_RADIUS,
  PLAYER_W,
  PLAYER_H,
  TARGET_CHAR_HEIGHT,
  TARGET_NATIVE_HEIGHT,
} from "../world/gameplayConstants";
import type { Direction, NpcDef, NpcInstance } from "./types";
import type { NavGrid } from "../world/NavGrid";

/**
 * Owns every visual + AI concern for the cast of characters on the map
 * (teachers, students, even the player when it comes to sprite loading).
 * The scene only knows how to *ask for* a sprite or for a wander update; the
 * details live here.
 */
export class NpcManager {
  readonly npcs: NpcInstance[] = [];
  /** Phaser physics group that owns the npc sprites for collision wiring. */
  group!: Phaser.Physics.Arcade.Group;

  /** IDs of characters whose `right` direction is the flipped `left` sprite. */
  private readonly charNeedsRightFlip = new Set<string>();

  private navGrid?: NavGrid;

  constructor(private readonly scene: Phaser.Scene) {}

  /** Wire the nav grid for collision-aware wandering. */
  setNavGrid(grid: NavGrid): void {
    this.navGrid = grid;
  }

  /** Build the physics group + collider wiring. Call once in scene.create(). */
  init(args: {
    player: Phaser.Physics.Arcade.Sprite;
    obstacles: Phaser.Physics.Arcade.StaticGroup;
  }): void {
    this.group = this.scene.physics.add.group();
    this.scene.physics.add.collider(args.player, this.group);
    this.scene.physics.add.collider(this.group, args.obstacles);
    this.scene.physics.add.collider(this.group, this.group);
  }

  needsRightFlip(id: string): boolean {
    return this.charNeedsRightFlip.has(id);
  }

  // ----- Spawn / destroy -----

  spawn(def: NpcDef): NpcInstance {
    const spriteKey = this.buildCharacterAnimations(
      def.id,
      "#6b7280",
      "#fcd9b6",
      def.sprite
    );
    const sprite = this.scene.physics.add.sprite(def.x, def.y, spriteKey);
    sprite.setCollideWorldBounds(true);
    this.scaleCharacterIfReal(sprite, spriteKey);
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    body.pushable = false;
    body.setSize(sprite.width * HITBOX_W_RATIO, sprite.height * HITBOX_H_RATIO);
    body.setOffset(
      (sprite.width * (1 - HITBOX_W_RATIO)) / 2,
      sprite.height * (1 - HITBOX_H_RATIO)
    );
    sprite.setDepth(layerDepth.AGENTS + Math.round(def.y));
    sprite.play(`${def.id}_idle_down`);

    if (this.group) this.group.add(sprite);

    const instance: NpcInstance = {
      def,
      sprite,
      home: { x: def.x, y: def.y },
      state: "idle",
      nextStateAt:
        this.scene.time.now + Phaser.Math.Between(NPC_PAUSE_MIN, NPC_PAUSE_MAX),
      lastDir: "down",
    };
    instance.statusBadge = this.makeStatusBadge(def.status ?? "idle");
    this.npcs.push(instance);
    return instance;
  }

  destroy(npc: NpcInstance): void {
    npc.statusBadge?.destroy();
    npc.activityBubble?.destroy();
    npc.statusGlyph?.destroy();
    npc.sprite.destroy();
    const idx = this.npcs.indexOf(npc);
    if (idx >= 0) this.npcs.splice(idx, 1);
  }

  /** Fade in the sprite + status badge (used when sub-agents spawn). */
  fadeIn(npc: NpcInstance): void {
    const targets: Phaser.GameObjects.GameObject[] = [npc.sprite];
    if (npc.statusBadge) targets.push(npc.statusBadge);
    npc.sprite.setAlpha(0);
    npc.statusBadge?.setAlpha(0);
    this.scene.tweens.add({
      targets,
      alpha: 1,
      duration: 350,
      ease: Phaser.Math.Easing.Quadratic.Out,
    });
  }

  /** Fade everything out then destroy the npc. */
  fadeOutAndDestroy(npc: NpcInstance): void {
    const targets: Phaser.GameObjects.GameObject[] = [npc.sprite];
    if (npc.statusBadge) targets.push(npc.statusBadge);
    if (npc.statusGlyph) targets.push(npc.statusGlyph);
    if (npc.activityBubble) targets.push(npc.activityBubble);
    this.scene.tweens.add({
      targets,
      alpha: 0,
      duration: 400,
      ease: Phaser.Math.Easing.Quadratic.In,
      onComplete: () => this.destroy(npc),
    });
  }

  // ----- Status overlays -----

  refreshStatusBadge(npc: NpcInstance): void {
    npc.statusBadge?.destroy();
    npc.statusBadge = this.makeStatusBadge(npc.def.status ?? "idle");
    this.refreshStatusGlyph(npc);
  }

  private makeStatusBadge(status: AgentStatus): Phaser.GameObjects.Graphics {
    const g = this.scene.add.graphics();
    g.fillStyle(STATUS_COLOR_HEX[status], 1);
    g.fillCircle(0, 0, 5);
    g.lineStyle(1, 0x111111, 0.9);
    g.strokeCircle(0, 0, 5);
    g.setDepth(layerDepth.OVERLAYS);
    return g;
  }

  private refreshStatusGlyph(npc: NpcInstance): void {
    const status = npc.def.status;
    const want = status === "awaiting_approval" || status === "blocked";
    if (!want) {
      npc.statusGlyph?.destroy();
      npc.statusGlyph = undefined;
      return;
    }
    if (npc.statusGlyph) return;
    const isBlocked = status === "blocked";
    const text = isBlocked ? "!" : "?";
    const color = isBlocked ? "#ef4444" : "#eab308";
    const t = this.scene.add
      .text(0, 0, text, {
        fontSize: "20px",
        fontStyle: "bold",
        color,
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0.5);
    const container = this.scene.add.container(0, 0, [t]);
    container.setSize(t.width, t.height);
    container.setDepth(layerDepth.OVERLAYS + 2);
    npc.statusGlyph = container;
  }

  /** Pop a transient bubble above the agent's head with their current activity. */
  showActivityBubble(npc: NpcInstance): void {
    const tool = npc.def.currentTool;
    if (!tool) {
      npc.activityBubble?.destroy();
      npc.activityBubble = undefined;
      return;
    }
    const detail = npc.def.currentToolDetail;
    const text = detail ? `${tool} · ${detail}` : tool;

    npc.activityBubble?.destroy();

    const padX = 6;
    const padY = 3;
    const label = this.scene.add.text(0, 0, text, {
      fontSize: "10px",
      color: "#1a202c",
      wordWrap: { width: 220 },
    });
    const w = Math.min(label.width, 220) + padX * 2;
    const h = label.height + padY * 2 + 4;
    const bg = this.scene.add.graphics();
    bg.fillStyle(0xffffff, 0.95);
    bg.lineStyle(1, 0x111111, 0.9);
    bg.fillRoundedRect(0, 0, w, h, 5);
    bg.strokeRoundedRect(0, 0, w, h, 5);
    bg.fillTriangle(w / 2 - 4, h, w / 2 + 4, h, w / 2, h + 5);
    bg.lineBetween(w / 2 - 4, h, w / 2, h + 5);
    bg.lineBetween(w / 2, h + 5, w / 2 + 4, h);
    label.setPosition(padX, padY);

    const container = this.scene.add.container(0, 0, [bg, label]);
    container.setSize(w, h);
    container.setDepth(layerDepth.OVERLAYS);
    npc.activityBubble = container;
    this.positionActivityBubble(npc);

    this.scene.tweens.add({
      targets: container,
      alpha: 0,
      delay: 3500,
      duration: 500,
      onComplete: () => {
        if (npc.activityBubble === container) npc.activityBubble = undefined;
        container.destroy();
      },
    });
  }

  // ----- Per-frame update -----

  /**
   * Run the wander AI + sync depth + reposition every overlay. `frozenFor` is
   * the NPC the user is currently chatting with — it stays still.
   */
  updateAll(now: number, frozenFor: NpcInstance | undefined): void {
    for (const npc of this.npcs) {
      this.updateNpc(npc, now, frozenFor === npc);
      npc.sprite.setDepth(layerDepth.AGENTS + Math.round(npc.sprite.y));
      this.repositionBadge(npc);
      this.repositionGlyph(npc);
      this.positionActivityBubble(npc);
    }
  }

  private updateNpc(npc: NpcInstance, now: number, frozenForDialogue: boolean): void {
    const id = npc.def.id;
    const playIdle = () => {
      npc.sprite.play(`${id}_idle_${npc.lastDir}`, true);
      npc.sprite.setFlipX(this.charNeedsRightFlip.has(id) && npc.lastDir === "right");
    };

    if (frozenForDialogue) {
      npc.sprite.setVelocity(0, 0);
      playIdle();
      return;
    }

    // Pinned statuses: the agent stands still. Movement would be a distraction
    // when the agent is actually waiting / stuck / done.
    const status = npc.def.status ?? "idle";
    if (
      status === "blocked" ||
      status === "awaiting_approval" ||
      status === "done" ||
      status === "idle"
    ) {
      npc.sprite.setVelocity(0, 0);
      playIdle();
      return;
    }

    if (npc.state === "idle") {
      if (now >= npc.nextStateAt) {
        npc.target = this.pickWanderTarget(npc);
        npc.state = "moving";
        npc.stuckSince = undefined;
      } else {
        npc.sprite.setVelocity(0, 0);
        playIdle();
      }
      return;
    }

    if (!npc.target) {
      npc.state = "idle";
      npc.nextStateAt = now + Phaser.Math.Between(NPC_PAUSE_MIN, NPC_PAUSE_MAX);
      return;
    }

    const dx = npc.target.x - npc.sprite.x;
    const dy = npc.target.y - npc.sprite.y;
    const dist = Math.hypot(dx, dy);

    if (dist < NPC_REACH_DIST) {
      npc.sprite.setVelocity(0, 0);
      npc.state = "idle";
      npc.target = undefined;
      npc.nextStateAt = now + Phaser.Math.Between(NPC_PAUSE_MIN, NPC_PAUSE_MAX);
      playIdle();
      return;
    }

    const inv = 1 / dist;
    const vx = dx * inv * NPC_SPEED;
    const vy = dy * inv * NPC_SPEED;
    npc.sprite.setVelocity(vx, vy);

    if (Math.abs(vx) >= Math.abs(vy)) {
      npc.lastDir = vx < 0 ? "left" : "right";
    } else {
      npc.lastDir = vy < 0 ? "up" : "down";
    }
    npc.sprite.play(`${id}_walk_${npc.lastDir}`, true);
    npc.sprite.setFlipX(this.charNeedsRightFlip.has(id) && npc.lastDir === "right");

    const body = npc.sprite.body as Phaser.Physics.Arcade.Body;
    const blocked =
      body.blocked.left || body.blocked.right || body.blocked.up || body.blocked.down;
    if (blocked) {
      npc.stuckSince ??= now;
      if (now - npc.stuckSince > NPC_STUCK_TIMEOUT) {
        npc.sprite.setVelocity(0, 0);
        npc.state = "idle";
        npc.target = undefined;
        npc.nextStateAt = now + Phaser.Math.Between(NPC_PAUSE_MIN / 2, NPC_PAUSE_MAX / 2);
        playIdle();
      }
    } else {
      npc.stuckSince = undefined;
    }
  }

  private pickWanderTarget(npc: NpcInstance): { x: number; y: number } {
    // Prefer a walkable target inside the wander ring around home. Falls back
    // to a random point — the stuck-detection loop will catch it.
    if (this.navGrid) {
      const pt = this.navGrid.randomWalkableNear(
        npc.home,
        20,
        NPC_WANDER_RADIUS
      );
      if (pt) return pt;
    }
    const angle = Math.random() * Math.PI * 2;
    const radius = Phaser.Math.Between(20, NPC_WANDER_RADIUS);
    return {
      x: npc.home.x + Math.cos(angle) * radius,
      y: npc.home.y + Math.sin(angle) * radius,
    };
  }

  private repositionBadge(npc: NpcInstance): void {
    if (!npc.statusBadge) return;
    const sprite = npc.sprite;
    npc.statusBadge.setPosition(sprite.x, sprite.y - sprite.displayHeight * 0.5 - 6);
    npc.statusBadge.setDepth(sprite.depth + 1);
  }

  private repositionGlyph(npc: NpcInstance): void {
    if (!npc.statusGlyph) return;
    const sprite = npc.sprite;
    // Gentle bob synced to global time so glyphs all bob in sync (cheap, no tween).
    const bob = Math.sin(this.scene.time.now / 280) * 3;
    npc.statusGlyph.setPosition(
      sprite.x,
      sprite.y - sprite.displayHeight * 0.5 - 22 + bob
    );
    npc.statusGlyph.setDepth(sprite.depth + 3);
  }

  private positionActivityBubble(npc: NpcInstance): void {
    if (!npc.activityBubble) return;
    const sprite = npc.sprite;
    const w = npc.activityBubble.width;
    const h = npc.activityBubble.height;
    npc.activityBubble.setPosition(
      sprite.x - w / 2,
      sprite.y - sprite.displayHeight * 0.5 - h - 14
    );
    npc.activityBubble.setDepth(sprite.depth + 2);
  }

  // ----- Sprite loading -----

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
