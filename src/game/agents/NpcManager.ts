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
} from "../world/gameplayConstants";
import type { NpcDef, NpcInstance } from "./types";
import type { NavGrid } from "../world/NavGrid";
import { CharacterSpriteFactory } from "./CharacterSpriteFactory";

/**
 * Owns the lifecycle, wander AI, and status overlays for the cast of
 * characters on the map (teachers, students, even the player). Sprite
 * loading is delegated to {@link CharacterSpriteFactory} so this class can
 * stay focused on behaviour rather than pixel-pushing.
 */
export class NpcManager {
  readonly npcs: NpcInstance[] = [];
  /** Phaser physics group that owns the npc sprites for collision wiring. */
  group!: Phaser.Physics.Arcade.Group;

  private readonly spriteFactory: CharacterSpriteFactory;
  private navGrid?: NavGrid;

  constructor(private readonly scene: Phaser.Scene) {
    this.spriteFactory = new CharacterSpriteFactory(scene);
  }

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

  // ----- Sprite-factory passthroughs (kept as facade so PlayerController and
  // other consumers don't reach into the factory directly). -----

  needsRightFlip(id: string): boolean {
    return this.spriteFactory.needsRightFlip(id);
  }

  buildCharacterAnimations(
    id: string,
    bodyHex: string,
    headHex: string,
    spriteSource?: string
  ): string {
    return this.spriteFactory.buildCharacterAnimations(id, bodyHex, headHex, spriteSource);
  }

  scaleCharacterIfReal(sprite: Phaser.Physics.Arcade.Sprite, initialKey: string): void {
    this.spriteFactory.scaleCharacterIfReal(sprite, initialKey);
  }

  // ----- Spawn / destroy -----

  spawn(def: NpcDef): NpcInstance {
    // Snap the desired spawn position to the nearest walkable nav-grid cell so
    // agents never materialise inside furniture collision rectangles.
    if (this.navGrid) {
      const safe = this.navGrid.snapToWalkable(def.x, def.y);
      if (safe) def = { ...def, x: safe.x, y: safe.y };
    }

    const spriteKey = this.spriteFactory.buildCharacterAnimations(
      def.id,
      def.hairColor ?? "#6b7280",
      def.clothesColor ?? "#fcd9b6",
      def.sprite
    );
    const sprite = this.scene.physics.add.sprite(def.x, def.y, spriteKey);
    sprite.setCollideWorldBounds(true);
    this.spriteFactory.scaleCharacterIfReal(sprite, spriteKey);
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
    if (def.showBadge !== false) {
      instance.statusBadge = this.makeStatusBadge(def.status ?? "idle");
    }
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
    npc.statusBadge =
      npc.def.showBadge !== false
        ? this.makeStatusBadge(npc.def.status ?? "idle")
        : undefined;
    this.refreshStatusGlyph(npc);
    // P1: clear persistent activity bubble when leaving an active status
    const s = npc.def.status;
    if (s !== "coding" && s !== "running_tool") {
      npc.activityBubble?.destroy();
      npc.activityBubble = undefined;
    }
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

  /**
   * Show a bubble with the agent's current tool + detail.
   * When `persistent` is true the bubble stays until explicitly cleared
   * (used for coding / running_tool so the detail stays visible in real-time).
   */
  showActivityBubble(npc: NpcInstance, persistent = false): void {
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

    if (!persistent) {
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
      npc.sprite.setFlipX(this.spriteFactory.needsRightFlip(id) && npc.lastDir === "right");
    };

    if (frozenForDialogue || npc.def.static) {
      npc.sprite.setVelocity(0, 0);
      playIdle();
      return;
    }

    // Pinned statuses: the agent stands still, with per-status animation.
    const status = npc.def.status ?? "idle";
    if (
      status === "blocked" ||
      status === "awaiting_approval" ||
      status === "done" ||
      status === "idle" ||
      status === "coding" ||       // P2: no wander during active work
      status === "running_tool" ||
      status === "planning"
    ) {
      npc.sprite.setVelocity(0, 0);
      playIdle();

      // Capture the rest Y on the first frame of this status
      if (npc.lastAnimStatus !== status) {
        npc.animBaseY = npc.sprite.y;
        npc.lastAnimStatus = status;
      }
      const baseY = npc.animBaseY!;

      if (status === "awaiting_approval") {
        // Bounce marqué : ±6px, période ~350ms
        npc.sprite.setY(baseY + Math.sin(now / 350) * 6);
      } else if (status === "blocked") {
        // Oscillation lente : ±3px, période ~900ms
        npc.sprite.setY(baseY + Math.sin(now / 900) * 3);
      } else if (status === "coding" || status === "running_tool") {
        // Micro-vibration rapide : ±1.5px, période ~55ms
        npc.sprite.setY(baseY + Math.sin(now / 55) * 1.5);
      }

      return;
    }

    // Leaving a pinned status — clear animation context
    npc.animBaseY = undefined;
    npc.lastAnimStatus = undefined;

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
    npc.sprite.setFlipX(this.spriteFactory.needsRightFlip(id) && npc.lastDir === "right");

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
    npc.statusGlyph.setPosition(
      sprite.x,
      sprite.y - sprite.displayHeight * 0.5 - 22
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
}
