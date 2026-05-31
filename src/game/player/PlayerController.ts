import Phaser from "phaser";
import { layerDepth } from "../config/grid";
import {
  INTERACTION_RADIUS,
  HITBOX_W_RATIO,
  HITBOX_H_RATIO,
  PLAYER_SPEED,
} from "../world/gameplayConstants";
import type { House } from "../world/houseLayout";
import type { Direction, NpcInstance } from "../agents/types";
import type { NpcManager } from "../agents/NpcManager";
import type { DialogueUI } from "../ui/DialogueUI";
import type { RPGApprovalUI } from "../ui/RPGApprovalUI";
import type { RPGAgentMenuUI } from "../ui/RPGAgentMenuUI";
import type { NavGrid } from "../world/NavGrid";

interface AutoWalkState {
  waypoints: Array<{ x: number; y: number }>;
  targetId: string;
  stuckSince?: number;
  lastDist: number;
}

export interface PlayerControllerDeps {
  /** Resolve an NPC by its NpcDef.id (sessionId for teachers, sub-id for students). */
  findNpcById: (id: string) => NpcInstance | undefined;
  /** Resolve the house an NPC lives in, so the autopilot can route via its entrance. */
  findHouseForNpc: (npc: NpcInstance) => House | undefined;
  /** Called when the player presses Space on the Professor NPC. */
  onProfessorInteract?: () => void;
  /** Called when the player presses Space near the routines panel (in the garden). */
  onRoutinesPanelInteract?: () => void;
  /** Routines panel world position — pass null when not yet built. The player
   *  controller uses this each frame for proximity detection. */
  routinesPanelPosition?: () => { x: number; y: number } | null;
}

/**
 * Owns the player sprite and everything keyboard-driven: walking, the
 * 4-direction animation, the "[Space] talk to" interaction, and the
 * click-to-walk autopilot fed by the sidebar.
 *
 * Note: pre-2026-05-30, two distinct keys split the interaction surface (E
 * for dialogue/approval, Space for the action menu). They were unified to
 * Space-only — the agent menu now carries the status+tool header that E
 * used to surface via DialogueUI. The DialogueUI is retained only for the
 * floating "[Space] talk to …" prompt above NPCs.
 */
export class PlayerController {
  private player!: Phaser.Physics.Arcade.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private menuKey!: Phaser.Input.Keyboard.Key;
  private lastDir: Direction = "down";
  private autoWalk?: AutoWalkState;
  private navGrid?: NavGrid;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly npcManager: NpcManager,
    private readonly dialogue: DialogueUI,
    private readonly approvalUI: RPGApprovalUI,
    private readonly agentMenu: RPGAgentMenuUI,
    private readonly deps: PlayerControllerDeps
  ) {}

  /**
   * Spawn the player sprite and wire keyboard input. Returns the sprite so
   * the scene can hook collisions / camera follow on top of it.
   */
  init(spawn: { x: number; y: number }): Phaser.Physics.Arcade.Sprite {
    const spriteKey = this.npcManager.buildCharacterAnimations(
      "player",
      "#2b6cb0",
      "#f6ad55"
    );
    const sprite = this.scene.physics.add.sprite(spawn.x, spawn.y, spriteKey);
    sprite.setCollideWorldBounds(true);
    sprite.setDepth(layerDepth.AGENTS);
    this.npcManager.scaleCharacterIfReal(sprite, spriteKey);

    const body = sprite.body as Phaser.Physics.Arcade.Body;
    const pw = sprite.width;
    const ph = sprite.height;
    body.setSize(pw * HITBOX_W_RATIO, ph * HITBOX_H_RATIO);
    body.setOffset((pw * (1 - HITBOX_W_RATIO)) / 2, ph * (1 - HITBOX_H_RATIO));

    sprite.play("player_idle_down");
    this.player = sprite;

    this.cursors = this.scene.input.keyboard!.createCursorKeys();
    this.menuKey = this.scene.input.keyboard!.addKey(
      Phaser.Input.Keyboard.KeyCodes.SPACE
    );
    // Allow DOM inputs (chat, sidebar) to receive key events without Phaser
    // calling preventDefault() on them. Phaser's internal key state tracking
    // continues to work normally — player movement and interactions remain OK.
    this.scene.input.keyboard!.disableGlobalCapture();
    this.approvalUI.init();
    this.agentMenu.init();

    return sprite;
  }

  /** The player sprite for collider wiring and camera follow. */
  get sprite(): Phaser.Physics.Arcade.Sprite {
    return this.player;
  }

  /** Wire the nav grid for A* click-to-walk. Call once after CollisionLayer.load. */
  setNavGrid(grid: NavGrid): void {
    this.navGrid = grid;
  }

  /**
   * Run the per-frame movement + animation + interaction logic. Should be
   * called from the scene's `update()` once per tick.
   */
  update(): void {
    const speed = PLAYER_SPEED;
    let vx = 0;
    let vy = 0;

    const anyArrow =
      this.cursors.left.isDown ||
      this.cursors.right.isDown ||
      this.cursors.up.isDown ||
      this.cursors.down.isDown;
    if (anyArrow && this.autoWalk) this.autoWalk = undefined;

    if (this.autoWalk) {
      const walk = this.autoWalk;
      const wp = walk.waypoints[0];
      if (!wp) {
        this.autoWalk = undefined;
      } else {
        const dx = wp.x - this.player.x;
        const dy = wp.y - this.player.y;
        const dist = Math.hypot(dx, dy);

        if (dist < 14) {
          walk.waypoints.shift();
          if (walk.waypoints.length === 0) {
            const targetId = walk.targetId;
            this.autoWalk = undefined;
            const target = this.deps.findNpcById(targetId);
            if (target) {
              this.openInteractionFor(target);
            }
          }
        } else {
          const inv = 1 / dist;
          vx = dx * inv * speed;
          vy = dy * inv * speed;

          // Stuck detection — give up after ~1.2 s of no progress against a wall.
          const body = this.player.body as Phaser.Physics.Arcade.Body;
          const blocked =
            body.blocked.left || body.blocked.right || body.blocked.up || body.blocked.down;
          if (blocked && Math.abs(walk.lastDist - dist) < 1) {
            walk.stuckSince ??= this.scene.time.now;
            if (this.scene.time.now - walk.stuckSince > 1200) {
              this.autoWalk = undefined;
              vx = 0;
              vy = 0;
            }
          } else {
            walk.stuckSince = undefined;
          }
          walk.lastDist = dist;
        }
      }
    } else {
      if (this.cursors.left.isDown) vx = -speed;
      else if (this.cursors.right.isDown) vx = speed;
      if (this.cursors.up.isDown) vy = -speed;
      else if (this.cursors.down.isDown) vy = speed;
    }

    if (vx !== 0 && vy !== 0) {
      const inv = 1 / Math.SQRT2;
      vx *= inv;
      vy *= inv;
    }

    this.player.setVelocity(vx, vy);
    this.player.setDepth(layerDepth.AGENTS + Math.round(this.player.y));

    const moving = vx !== 0 || vy !== 0;
    if (moving) {
      if (Math.abs(vx) >= Math.abs(vy) && vx !== 0) {
        this.lastDir = vx < 0 ? "left" : "right";
      } else if (vy !== 0) {
        this.lastDir = vy < 0 ? "up" : "down";
      }
    }
    this.player.play(`player_${moving ? "walk" : "idle"}_${this.lastDir}`, true);
    this.player.setFlipX(
      this.npcManager.needsRightFlip("player") && this.lastDir === "right"
    );

    this.approvalUI.update();
    this.agentMenu.update();
    this.updateNearestNpc();
    this.updateMenuInput();
  }

  /**
   * "Found you" feedback + auto-walk to the agent. Triggered by the sidebar
   * `highlight_agent` event.
   */
  highlightAgent(id: string): void {
    const npc = this.deps.findNpcById(id);
    if (!npc) return;

    // Quick hop on the agent.
    const sprite = npc.sprite;
    const restY = sprite.y;
    this.scene.tweens.add({
      targets: sprite,
      y: restY - 14,
      duration: 160,
      ease: Phaser.Math.Easing.Quadratic.Out,
      yoyo: true,
      repeat: 1,
      onComplete: () => sprite.setY(restY),
    });

    this.startAutoWalk(npc);
  }

  private startAutoWalk(npc: NpcInstance): void {
    // Aim a few pixels below the agent so the player ends up facing them.
    const goal = { x: npc.sprite.x, y: npc.sprite.y + 24 };
    const start = { x: this.player.x, y: this.player.y };

    let waypoints: Array<{ x: number; y: number }> | null = null;

    if (this.navGrid) {
      const path = this.navGrid.findPath(start, goal);
      if (path && path.length > 0) {
        // Drop the first waypoint (= snapped current position) to avoid a
        // pointless micro-step at the start.
        waypoints = path.slice(1);
        if (waypoints.length === 0) waypoints = [goal];
      }
    }

    if (!waypoints) {
      // Fallback: route via the house entrance when the player is clearly
      // outside, otherwise head straight there.
      const house = this.deps.findHouseForNpc(npc);
      const alreadyInside = house ? this.player.y < house.center.y + 140 : true;
      waypoints = [];
      if (house && !alreadyInside) {
        waypoints.push({ x: house.entrance.x, y: house.entrance.y });
      }
      waypoints.push(goal);
    }

    this.autoWalk = {
      waypoints,
      targetId: npc.def.id,
      lastDist: Infinity,
    };
  }

  private updateNearestNpc(): void {
    let best: NpcInstance | undefined;
    let bestDist = INTERACTION_RADIUS;
    for (const npc of this.npcManager.npcs) {
      const dx = npc.sprite.x - this.player.x;
      const dy = npc.sprite.y - this.player.y;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        best = npc;
      }
    }
    this.dialogue.setNearest(best);
  }

  private updateMenuInput(): void {
    // Other modal UIs absorb their own keys — don't double-handle Space.
    if (this.approvalUI.isOpen()) return;
    if (this.agentMenu.isOpen()) return;

    if (!Phaser.Input.Keyboard.JustDown(this.menuKey)) return;

    // Routines panel takes priority over NPCs when in range — there's no
    // visual overlap in practice (panel in garden, NPCs in houses) but
    // we still resolve deterministically.
    if (this.isPlayerNearRoutinesPanel()) {
      this.deps.onRoutinesPanelInteract?.();
      return;
    }

    // Re-evaluate the nearest NPC each press so Space always targets the freshest one.
    let best: NpcInstance | undefined;
    let bestDist = INTERACTION_RADIUS;
    for (const npc of this.npcManager.npcs) {
      const d = Math.hypot(
        npc.sprite.x - this.player.x,
        npc.sprite.y - this.player.y
      );
      if (d < bestDist) {
        bestDist = d;
        best = npc;
      }
    }
    if (!best) return;

    this.openInteractionFor(best);
  }

  /**
   * True if the player is close enough to the routines panel to interact
   * with it. Uses the same INTERACTION_RADIUS as NPC dialogue for
   * consistency.
   */
  private isPlayerNearRoutinesPanel(): boolean {
    const pos = this.deps.routinesPanelPosition?.();
    if (!pos) return false;
    const d = Math.hypot(pos.x - this.player.x, pos.y - this.player.y);
    return d < INTERACTION_RADIUS;
  }

  /**
   * Single entry point for "interact with this NPC". Replaces the old E/Space
   * split. Routes the target NPC to the most appropriate UI:
   *
   * - Le Professeur → `onProfessorInteract` (spawn/reuse his session)
   * - awaiting_approval + pending plan/questions → RPGApprovalUI (urgent)
   * - everything else → RPGAgentMenuUI (status header + 5 actions)
   *
   * The legacy DialogueUI is no longer opened — its info (status, tool,
   * detail) is now shown at the top of the agent menu.
   */
  private openInteractionFor(npc: NpcInstance): void {
    if (npc.def.id === "professor") {
      this.deps.onProfessorInteract?.();
      return;
    }

    // Close any leftover floating bubble (shouldn't normally be open, but
    // we may add fallbacks later that re-enable it).
    if (this.dialogue.isOpen()) this.dialogue.close();

    const hasPending =
      npc.def.pendingPlan !== undefined ||
      (npc.def.pendingQuestions?.length ?? 0) > 0;
    if (npc.def.status === "awaiting_approval" && hasPending) {
      this.approvalUI.open(npc);
      return;
    }

    this.agentMenu.open(npc);
  }
}
