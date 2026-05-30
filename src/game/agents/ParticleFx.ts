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
