import Phaser from "phaser";
import { layerDepth } from "../config/grid";
import type { AgentStatus } from "../../../shared/agent-types";
import type { NpcInstance } from "./types";

/**
 * Particle effects layer keyed by NPC.
 *
 * The map status drives the emitter — a NPC in `coding` shows sparkles,
 * `blocked` shows smoke, transitions to `done` fire a one-shot confetti
 * burst. Continuous effects are tied to the NPC sprite via `startFollow`
 * so they move with it.
 *
 * Effects are kept lightweight (1 particle every ~200 ms) so the
 * 100+ agents stretch in TD.1 stays reachable.
 */
export class ParticleFx {
  /** Procedural 8×8 white circle baked once, tinted at emitter level. */
  private static readonly TEXTURE_KEY = "fx_dot";

  /**
   * Per-NPC live emitters. We hold them so we can stop/destroy them on
   * status transitions without leaking emitters or particles.
   */
  private readonly emitters = new Map<
    NpcInstance,
    {
      sparkle?: Phaser.GameObjects.Particles.ParticleEmitter;
      smoke?: Phaser.GameObjects.Particles.ParticleEmitter;
      star?: Phaser.GameObjects.Particles.ParticleEmitter;
      /** Last status applied — used to detect transitions (e.g. → done). */
      prevStatus?: AgentStatus;
    }
  >();

  constructor(private readonly scene: Phaser.Scene) {
    this.ensureTexture();
  }

  /**
   * React to a status change for `npc`. Idempotent — calling twice with the
   * same status is a no-op.
   *
   * Called from NpcManager.refreshStatusBadge after `npc.def.status` has
   * been updated.
   */
  applyForStatus(npc: NpcInstance, status: AgentStatus): void {
    const entry = this.emitters.get(npc) ?? {};
    const prev = entry.prevStatus;
    if (prev === status) return;

    // ─── coding → sparkles violets (continuous) ─────────────────────────────
    if (status === "coding" && !entry.sparkle) {
      entry.sparkle = this.makeSparkleEmitter(npc);
    } else if (status !== "coding" && entry.sparkle) {
      entry.sparkle.destroy();
      entry.sparkle = undefined;
    }

    // ─── blocked → smoke gris (continuous) ──────────────────────────────────
    if (status === "blocked" && !entry.smoke) {
      entry.smoke = this.makeSmokeEmitter(npc);
    } else if (status !== "blocked" && entry.smoke) {
      entry.smoke.destroy();
      entry.smoke = undefined;
    }

    // ─── awaiting_approval → étoiles dorées (continuous radial) ─────────────
    if (status === "awaiting_approval" && !entry.star) {
      entry.star = this.makeStarEmitter(npc);
    } else if (status !== "awaiting_approval" && entry.star) {
      entry.star.destroy();
      entry.star = undefined;
    }

    // ─── task complete → one-shot confettis ─────────────────────────────────
    // Le parser passe en `idle` quand un stop_hook fire (turn fini par l'agent).
    // Status `done` n'arrive en pratique que sur SessionEnd ou via sous-agents,
    // d'où l'option de tirer aussi sur transition active → idle.
    const becameDone = status === "done" && prev !== undefined && prev !== "done";
    const finishedTurn =
      status === "idle" &&
      (prev === "coding" ||
        prev === "running_tool" ||
        prev === "planning" ||
        prev === "awaiting_approval");
    if (becameDone || finishedTurn) {
      this.fireConfetti(npc);
    }

    entry.prevStatus = status;
    this.emitters.set(npc, entry);
  }

  /**
   * Tear down emitters when the NPC is being destroyed. Called from
   * NpcManager.destroy.
   */
  destroy(npc: NpcInstance): void {
    const entry = this.emitters.get(npc);
    if (!entry) return;
    entry.sparkle?.destroy();
    entry.smoke?.destroy();
    entry.star?.destroy();
    this.emitters.delete(npc);
  }

  // ── Effects ────────────────────────────────────────────────────────────────

  private makeSparkleEmitter(
    npc: NpcInstance
  ): Phaser.GameObjects.Particles.ParticleEmitter {
    const emitter = this.scene.add.particles(0, 0, ParticleFx.TEXTURE_KEY, {
      // Stick the emitter to the NPC sprite — particles spawn at
      // sprite position + the offset (~ above the head).
      follow: npc.sprite,
      followOffset: { x: 0, y: -npc.sprite.displayHeight * 0.4 },
      tint: [0xa855f7, 0xc084fc, 0xd8b4fe], // violet palette, sampled randomly
      lifespan: 700,
      speed: { min: 20, max: 45 },
      angle: { min: -110, max: -70 }, // upward cone
      scale: { start: 1.1, end: 0 },
      alpha: { start: 0.95, end: 0 },
      frequency: 220,
      quantity: 1,
      blendMode: Phaser.BlendModes.ADD,
    });
    emitter.setDepth(layerDepth.OVERLAYS + 10);
    return emitter;
  }

  /**
   * One-shot burst de confettis sur task complete. Pas attaché au sprite
   * (le NPC est de toute façon stationnaire en `done`) — la position est
   * snapshotée au moment du fire. L'émetteur s'auto-détruit après que
   * toutes les particules sont mortes pour éviter l'accumulation.
   */
  private fireConfetti(npc: NpcInstance): void {
    const emitter = this.scene.add.particles(0, 0, ParticleFx.TEXTURE_KEY, {
      // Palette saturée : rouge, orange, vert, cyan, violet, rose.
      tint: [0xef4444, 0xf59e0b, 0x84cc16, 0x06b6d4, 0xa855f7, 0xec4899],
      lifespan: 1300,
      speed: { min: 80, max: 180 },
      angle: { min: -180, max: 0 }, // hémisphère supérieur (vers le haut)
      scale: { start: 1.3, end: 0 },
      alpha: { start: 1, end: 0 },
      gravityY: 220, // les confettis tombent
      rotate: { start: 0, end: 360 }, // tumbling
      emitting: false, // explode manuel ci-dessous
    });
    emitter.setDepth(layerDepth.OVERLAYS + 11);

    const x = npc.sprite.x;
    const y = npc.sprite.y - npc.sprite.displayHeight * 0.4;
    emitter.explode(28, x, y);

    // Cleanup une fois la dernière particule morte (+ marge).
    this.scene.time.delayedCall(1600, () => emitter.destroy());
  }

  private makeStarEmitter(
    npc: NpcInstance
  ): Phaser.GameObjects.Particles.ParticleEmitter {
    const emitter = this.scene.add.particles(0, 0, ParticleFx.TEXTURE_KEY, {
      // Emitted around the head, like sparkles but with a different vibe.
      follow: npc.sprite,
      followOffset: { x: 0, y: -npc.sprite.displayHeight * 0.4 },
      // Gold/amber palette to match the floating ? glyph + yellow status badge.
      tint: [0xfbbf24, 0xfde047, 0xfacc15],
      lifespan: 900,
      // Slower than sparkles — signal d'attention, pas une fête.
      speed: { min: 25, max: 55 },
      // Radial : full 360° fan, l'étoile rayonne dans toutes les directions.
      angle: { min: 0, max: 360 },
      // Grossit en s'éteignant : effet "expanding shimmer".
      scale: { start: 0.3, end: 1.4 },
      alpha: { start: 1, end: 0 },
      frequency: 350,
      quantity: 1,
      // ADD blend pour le glow doré, cohérent avec les sparkles.
      blendMode: Phaser.BlendModes.ADD,
    });
    emitter.setDepth(layerDepth.OVERLAYS + 10);
    return emitter;
  }

  private makeSmokeEmitter(
    npc: NpcInstance
  ): Phaser.GameObjects.Particles.ParticleEmitter {
    const emitter = this.scene.add.particles(0, 0, ParticleFx.TEXTURE_KEY, {
      // Smoke rises slowly from just above the head.
      follow: npc.sprite,
      followOffset: { x: 0, y: -npc.sprite.displayHeight * 0.35 },
      // Gray palette, weighted dark→light so the column reads as smoke.
      tint: [0x6b7280, 0x9ca3af, 0x4b5563],
      lifespan: 1400,
      speed: { min: 8, max: 20 },
      angle: { min: -100, max: -80 }, // narrow upward cone
      // Smoke EXPANDS as it rises (opposite of sparkles).
      scale: { start: 0.8, end: 2.2 },
      // Starts faint and fades — no harsh visual punch.
      alpha: { start: 0.42, end: 0 },
      frequency: 280,
      quantity: 1,
      // Light negative gravity to encourage the upward drift without making
      // particles fly off-screen.
      gravityY: -10,
      // Normal blend so smoke looks dense, not glowy.
      blendMode: Phaser.BlendModes.NORMAL,
    });
    emitter.setDepth(layerDepth.OVERLAYS + 10);
    return emitter;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Bake a small white circle once into the Phaser texture cache, reused by
   * every emitter. Zero asset to ship.
   */
  private ensureTexture(): void {
    if (this.scene.textures.exists(ParticleFx.TEXTURE_KEY)) return;
    const g = this.scene.add.graphics();
    g.fillStyle(0xffffff, 1);
    g.fillCircle(4, 4, 4);
    g.generateTexture(ParticleFx.TEXTURE_KEY, 8, 8);
    g.destroy();
  }
}
