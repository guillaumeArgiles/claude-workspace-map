import Phaser from "phaser";
import { layerDepth } from "../config/grid";
import { uiBus } from "../services/uiBus";
import { t } from "../../i18n";
import { STATUS_COLOR_HEX } from "../../../shared/agent-ui";
import type { NpcInstance } from "../agents/types";
import type { NpcManager } from "../agents/NpcManager";

type ViewMode = "menu" | "plan";

interface MenuAction {
  key: string;
  label: string;
  description: string;
  /** When true, the option is greyed out (no ptyId yet, no plan, etc.). */
  disabled?: boolean;
  /** When true, the option is hidden (e.g. "voir le plan" when no plan). */
  hidden?: boolean;
  run: () => void;
}

/**
 * Camera-fixed RPG action menu, opened with [Space] on the nearest NPC.
 *
 * Five actions, gated on the agent's state and whether we have a linked PTY:
 *   [1] Voir la conversation        → open the terminal in the sidebar
 *   [2] Voir le plan                → show pendingPlan (only if available)
 *   [3] Poser une question          → open terminal + write "/btw "
 *   [4] Faire travailler plus vite  → write "/fast\r" to PTY
 *   [5] Tuer l'agent                → DELETE the PTY + fun death animation
 */
export class RPGAgentMenuUI {
  private container?: Phaser.GameObjects.Container;
  private openFor?: NpcInstance;
  private view: ViewMode = "menu";
  /** undefined = fetching | null = no PTY linked | string = found */
  private ptyId: string | null | undefined;

  private keyEsc!: Phaser.Input.Keyboard.Key;
  private keyNums!: Phaser.Input.Keyboard.Key[];

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly npcManager: NpcManager,
    /** Returns the player sprite — looked up lazily so the menu doesn't need to
     *  be constructed after PlayerController.init(). */
    private readonly getPlayer: () => Phaser.Physics.Arcade.Sprite
  ) {}

  init(): void {
    const kb = this.scene.input.keyboard!;
    this.keyEsc = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.keyNums = [
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.ONE),
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.TWO),
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.THREE),
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.FOUR),
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.FIVE),
    ];
  }

  isOpen(): boolean {
    return this.openFor !== undefined;
  }

  /** The NPC the menu is currently anchored to (used to freeze its wander). */
  get openNpc(): NpcInstance | undefined {
    return this.openFor;
  }

  open(npc: NpcInstance): void {
    const wasOpen = this.openFor !== undefined;
    this.close();
    this.openFor = npc;
    this.view = "menu";
    this.ptyId = undefined;
    this.render();
    // Only signal "open" if we weren't already open (close→open in one frame
    // would otherwise emit close, open and momentarily un-suspend the sidebar).
    if (!wasOpen) uiBus.emit("modal_open_changed", { open: true });
    void this.fetchPty(npc);
  }

  close(): void {
    const wasOpen = this.openFor !== undefined;
    this.container?.destroy();
    this.container = undefined;
    this.openFor = undefined;
    this.ptyId = undefined;
    this.view = "menu";
    if (wasOpen) uiBus.emit("modal_open_changed", { open: false });
  }

  update(): void {
    if (!this.openFor) return;

    if (Phaser.Input.Keyboard.JustDown(this.keyEsc)) {
      if (this.view === "plan") {
        this.view = "menu";
        this.render();
        return;
      }
      this.close();
      return;
    }

    // Auto-close if the NPC vanished (agent removed mid-menu).
    if (!this.npcManager.npcs.includes(this.openFor)) {
      this.close();
      return;
    }

    if (this.view === "menu") {
      const actions = this.buildActions();
      const visible = actions.filter((a) => !a.hidden);
      for (let i = 0; i < Math.min(visible.length, this.keyNums.length); i++) {
        if (Phaser.Input.Keyboard.JustDown(this.keyNums[i])) {
          const a = visible[i];
          if (!a.disabled) a.run();
          return;
        }
      }
    }
  }

  // ── PTY plumbing ───────────────────────────────────────────────────────────

  private async fetchPty(npc: NpcInstance): Promise<void> {
    let found: string | null = null;
    try {
      // 1) Direct sessionId → ptyId lookup (works when the watcher auto-linked
      //    PTY and sessionId after a sidebar-spawned session).
      const res = await fetch(
        `/api/sessions/by-session/${encodeURIComponent(npc.def.id)}`
      );
      const { ptyId } = (await res.json()) as { ptyId: string | null };
      found = ptyId;

      // 2) Fallback: any live PTY in the same cwd. "Voir la conversation"
      //    spawns a fresh Claude process which gets a *new* sessionId — but
      //    the user expects /btw and /fast to keep working against that same
      //    terminal. Match on cwd to bridge the gap.
      //
      //    NB: exitCode is absent on live PTYs (undefined drops out of JSON),
      //    so we treat both `undefined` and `null` as "still alive".
      if (!found && npc.def.cwd) {
        const listRes = await fetch("/api/sessions");
        const list = (await listRes.json()) as Array<{
          id: string;
          cwd: string;
          exitCode?: number | null;
          createdAt: number;
        }>;
        const match = list
          .filter((s) => s.cwd === npc.def.cwd && s.exitCode == null)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        found = match?.id ?? null;
      }
    } catch {
      found = null;
    }
    // Bail if the menu has been closed or moved on to a different NPC.
    if (this.openFor !== npc) return;
    this.ptyId = found;
    if (this.view === "menu") this.render();
  }

  private async writeToPty(text: string): Promise<void> {
    if (!this.ptyId) return;
    try {
      await fetch(`/api/sessions/${this.ptyId}/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch {
      /* PTY may have closed */
    }
  }

  private async killPty(): Promise<void> {
    if (!this.ptyId) return;
    try {
      await fetch(`/api/sessions/${this.ptyId}`, { method: "DELETE" });
    } catch {
      /* ignore */
    }
  }

  private async dismissAgent(sessionId: string): Promise<void> {
    try {
      await fetch(`/api/agents/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    } catch {
      /* ignore */
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  private buildActions(): MenuAction[] {
    const npc = this.openFor!;
    const sessionId = npc.def.id;
    const hasPty = this.ptyId != null;
    const loadingPty = this.ptyId === undefined;
    const hasPlan = Boolean(npc.def.pendingPlan?.trim());

    return [
      {
        key: "1",
        label: t("agent_menu.see_conversation"),
        description: t("agent_menu.see_conversation.desc"),
        run: () => {
          uiBus.emit("open_terminal", { sessionId });
          this.close();
        },
      },
      {
        key: "2",
        label: t("agent_menu.see_plan"),
        description: t("agent_menu.see_plan.desc"),
        hidden: !hasPlan,
        run: () => {
          this.view = "plan";
          this.render();
        },
      },
      {
        key: hasPlan ? "3" : "2",
        label: t("agent_menu.ask"),
        description: hasPty
          ? t("agent_menu.ask.btw")
          : loadingPty
            ? t("agent_menu.ask.connecting")
            : t("agent_menu.ask.no_pty"),
        disabled: !hasPty,
        run: () => {
          void this.writeToPty("/btw ");
          uiBus.emit("open_terminal", { sessionId });
          this.close();
        },
      },
      {
        key: hasPlan ? "4" : "3",
        label: t("agent_menu.work_faster"),
        description: hasPty
          ? t("agent_menu.work_faster.fast")
          : loadingPty
            ? t("agent_menu.ask.connecting")
            : t("agent_menu.work_faster.no_pty"),
        disabled: !hasPty,
        run: () => {
          const npcRef = this.openFor;
          // writeToPty captures ptyId synchronously before the fetch suspends,
          // so it's safe to close() right after.
          void this.writeToPty("/fast\r");
          if (npcRef) this.playWhipAnimation(npcRef);
          this.close();
        },
      },
      {
        key: hasPlan ? "5" : "4",
        label: t("agent_menu.kill"),
        description: t("agent_menu.kill.desc"),
        run: () => {
          const npcRef = this.openFor;
          this.close();
          if (npcRef) this.playKillAnimation(npcRef);
          void this.killPty();
          void this.dismissAgent(sessionId);
        },
      },
    ];
  }

  // ── Whip animation ─────────────────────────────────────────────────────────

  /**
   * Draws a quadratic-bezier whip from the upper-left of the NPC, snaps it
   * onto the sprite (crack flash + squash/stretch + tint), and leaves a brief
   * trail of speed lines streaking off the NPC.
   *
   * Runs entirely on the scene — safe to call after this.close().
   */
  private playWhipAnimation(npc: NpcInstance): void {
    const sprite = npc.sprite;
    const sx = sprite.x;
    const sy = sprite.y;
    const baseDepth = sprite.depth;

    // Tip lands on the NPC's torso, slightly above centre.
    const tipX = sx;
    const tipY = sy - sprite.displayHeight * 0.2;

    // Handle is anchored on the player — roughly at hand height.
    const player = this.getPlayer();
    const handleX = player.x;
    const handleY = player.y - player.displayHeight * 0.1;

    // Bow the curve upward (perpendicular to the player→NPC line). This keeps
    // the whip readable regardless of which side of the agent the player is on:
    // long horizontal shots get a big arc, short close-range ones stay tight.
    const dx = tipX - handleX;
    const dy = tipY - handleY;
    const len = Math.max(Math.hypot(dx, dy), 1);
    let perpX = -dy / len;
    let perpY = dx / len;
    // Force the arc to bulge upward (toward smaller y) regardless of approach angle.
    if (perpY > 0) {
      perpX = -perpX;
      perpY = -perpY;
    }
    const arcOffset = 36 + len * 0.22;
    const midX = (handleX + tipX) / 2;
    const midY = (handleY + tipY) / 2;
    const ctrlX = midX + perpX * arcOffset;
    const ctrlY = midY + perpY * arcOffset;

    const curve = new Phaser.Curves.QuadraticBezier(
      new Phaser.Math.Vector2(handleX, handleY),
      new Phaser.Math.Vector2(ctrlX, ctrlY),
      new Phaser.Math.Vector2(tipX, tipY)
    );
    const points = curve.getPoints(24);

    const whip = this.scene.add.graphics();
    // Render above both player and NPC so the whip "passes in front" of them.
    whip.setDepth(Math.max(player.depth, baseDepth) + 80);

    const drawTo = (k: number) => {
      whip.clear();
      if (k <= 0) return;
      // Dark outer stroke (whip body)
      whip.lineStyle(4, 0x111111, 1);
      whip.beginPath();
      whip.moveTo(points[0].x, points[0].y);
      for (let i = 1; i <= k && i < points.length; i++) {
        whip.lineTo(points[i].x, points[i].y);
      }
      whip.strokePath();
      // Inner highlight (leather sheen)
      whip.lineStyle(1.5, 0xfbbf24, 0.95);
      whip.beginPath();
      whip.moveTo(points[0].x, points[0].y);
      for (let i = 1; i <= k && i < points.length; i++) {
        whip.lineTo(points[i].x, points[i].y);
      }
      whip.strokePath();
    };

    // Phase 1 — whip unfurls in 200ms with an ease-in (the tip accelerates).
    this.scene.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 200,
      ease: Phaser.Math.Easing.Cubic.In,
      onUpdate: (tw) => drawTo(Math.floor((tw.getValue() ?? 0) * (points.length - 1))),
      onComplete: () => {
        this.playWhipCrack(tipX, tipY, baseDepth);
        this.shakeNpcOnHit(npc);
        // Speed lines streak in the direction the agent is "fleeing" — i.e.
        // from the player toward (and past) the NPC.
        const fleeX = dx / len;
        const fleeY = dy / len;
        this.emitSpeedLines(sx, sy, sprite.displayHeight, baseDepth, fleeX, fleeY);
        // Fade the whip out quickly after the crack.
        this.scene.tweens.add({
          targets: whip,
          alpha: 0,
          duration: 160,
          ease: Phaser.Math.Easing.Quadratic.Out,
          onComplete: () => whip.destroy(),
        });
      },
    });
  }

  private playWhipCrack(x: number, y: number, baseDepth: number): void {
    // Yellow shock ring
    const ring = this.scene.add.graphics();
    ring.setDepth(baseDepth + 90);
    ring.lineStyle(3, 0xfbbf24, 1);
    ring.strokeCircle(x, y, 4);
    this.scene.tweens.add({
      targets: ring,
      alpha: 0,
      duration: 280,
      onUpdate: (tw) => {
        const t = tw.progress;
        ring.clear();
        ring.lineStyle(3, 0xfbbf24, 1 - t);
        ring.strokeCircle(x, y, 4 + t * 22);
      },
      onComplete: () => ring.destroy(),
    });

    // ⚡ emoji at the impact point
    const bolt = this.scene.add
      .text(x, y - 4, "⚡", { fontSize: "22px" })
      .setOrigin(0.5, 0.5)
      .setDepth(baseDepth + 95)
      .setScale(0.4);
    this.scene.tweens.add({
      targets: bolt,
      scale: 1.6,
      alpha: 0,
      y: y - 24,
      duration: 380,
      ease: Phaser.Math.Easing.Quadratic.Out,
      onComplete: () => bolt.destroy(),
    });

    // A few yellow sparks shooting outward.
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 18 + Math.random() * 12;
      const spark = this.scene.add.rectangle(x, y, 3, 3, 0xfde047, 1);
      spark.setDepth(baseDepth + 85);
      this.scene.tweens.add({
        targets: spark,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
        alpha: 0,
        duration: 320,
        ease: Phaser.Math.Easing.Cubic.Out,
        onComplete: () => spark.destroy(),
      });
    }
  }

  private shakeNpcOnHit(npc: NpcInstance): void {
    const sprite = npc.sprite;
    const baseScaleX = sprite.scaleX;
    const baseScaleY = sprite.scaleY;

    // Squash-and-stretch reaction (sprite recoils then rebounds).
    this.scene.tweens.add({
      targets: sprite,
      scaleX: baseScaleX * 1.18,
      scaleY: baseScaleY * 0.82,
      duration: 90,
      ease: Phaser.Math.Easing.Quadratic.Out,
      yoyo: true,
    });

    // Yellow tint flash that fades back.
    sprite.setTintFill(0xfde047);
    this.scene.time.delayedCall(80, () => {
      sprite.setTint(0xfde047);
      this.scene.time.delayedCall(140, () => sprite.clearTint());
    });
  }

  private emitSpeedLines(
    sx: number,
    sy: number,
    spriteH: number,
    baseDepth: number,
    /** Unit vector — direction the agent is "fleeing" (away from the player). */
    dirX: number,
    dirY: number
  ): void {
    // Perpendicular vector to fan the lines vertically across the body.
    const perpX = -dirY;
    const perpY = dirX;

    for (let i = 0; i < 4; i++) {
      this.scene.time.delayedCall(60 * i, () => {
        const lateralOffset = (i - 1.5) * 5;
        const startX = sx + dirX * 14 + perpX * lateralOffset;
        const startY = sy + dirY * 14 + perpY * lateralOffset + spriteH * 0.1;
        const endX = sx + dirX * 60 + perpX * lateralOffset;
        const endY = sy + dirY * 60 + perpY * lateralOffset + spriteH * 0.1;

        const line = this.scene.add.rectangle(startX, startY, 18, 2, 0x60a5fa, 0.85);
        // Orient the line along the flee direction so it reads as a streak.
        line.setRotation(Math.atan2(dirY, dirX));
        line.setDepth(baseDepth + 70);

        this.scene.tweens.add({
          targets: line,
          x: endX,
          y: endY,
          alpha: 0,
          duration: 380,
          ease: Phaser.Math.Easing.Cubic.Out,
          onComplete: () => line.destroy(),
        });
      });
    }
  }

  // ── Kill animation ─────────────────────────────────────────────────────────

  private playKillAnimation(npc: NpcInstance): void {
    const sprite = npc.sprite;
    const sx = sprite.x;
    const sy = sprite.y;
    const groundY = sy + sprite.displayHeight * 0.35;
    const baseDepth = sprite.depth;

    // Stop physics so the sprite doesn't fight the death tween.
    const body = sprite.body as Phaser.Physics.Arcade.Body | null;
    if (body) {
      body.setVelocity(0, 0);
      body.enable = false;
    }
    npc.statusBadge?.destroy();
    npc.statusBadge = undefined;
    npc.statusGlyph?.destroy();
    npc.statusGlyph = undefined;
    npc.activityBubble?.destroy();
    npc.activityBubble = undefined;

    // 1) Red impact flash on the sprite — instant, fades over ~180ms.
    sprite.setTintFill(0xb91c1c);
    this.scene.time.delayedCall(70, () => {
      sprite.setTint(0xb91c1c);
      this.scene.time.delayedCall(110, () => sprite.clearTint());
    });

    // 2) Persistent blood splat on the ground (under the sprite).
    const splat = this.drawBloodSplat(sx, groundY, baseDepth - 1);
    // Linger for 2.5s then fade out so it doesn't pollute the map forever.
    this.scene.tweens.add({
      targets: splat,
      alpha: 0,
      delay: 2500,
      duration: 1500,
      onComplete: () => splat.destroy(),
    });

    // 3) Blood droplets — 9 dark red dots spurting out in an arc and landing.
    for (let i = 0; i < 9; i++) {
      this.spawnBloodDroplet(sx, sy, groundY, baseDepth);
    }

    // 4) ☠️ rising briefly above the corpse.
    const skull = this.scene.add
      .text(sx, sy - sprite.displayHeight * 0.3, "☠️", { fontSize: "20px" })
      .setOrigin(0.5, 0.5)
      .setDepth(baseDepth + 100)
      .setScale(0.4);
    this.scene.tweens.add({
      targets: skull,
      scale: 1.1,
      alpha: 0,
      y: sy - sprite.displayHeight * 0.3 - 28,
      duration: 800,
      ease: Phaser.Math.Easing.Quadratic.Out,
      onComplete: () => skull.destroy(),
    });

    // 5) Sprite collapses sideways onto the splat, then fades.
    this.scene.tweens.add({
      targets: sprite,
      angle: 78,
      y: sy + sprite.displayHeight * 0.18,
      duration: 320,
      ease: Phaser.Math.Easing.Cubic.In,
      onComplete: () => {
        this.scene.tweens.add({
          targets: sprite,
          alpha: 0,
          duration: 380,
          delay: 120,
          ease: Phaser.Math.Easing.Quadratic.In,
          onComplete: () => {
            // agent_removed SSE will destroy the npc for real; keep it hidden in the meantime.
            sprite.setVisible(false);
          },
        });
      },
    });
  }

  /**
   * Multi-layered splatter — darker outer halo, mid blob, brighter centre, plus
   * a handful of random satellite drops to break the silhouette.
   */
  private drawBloodSplat(x: number, y: number, depth: number): Phaser.GameObjects.Graphics {
    const g = this.scene.add.graphics();
    g.setDepth(depth);

    // Outer dark halo
    g.fillStyle(0x450a0a, 0.55);
    g.fillEllipse(x, y, 32, 18);

    // Main blob
    g.fillStyle(0x7f1d1d, 0.92);
    g.fillEllipse(x, y, 22, 12);

    // Inner bright red
    g.fillStyle(0xb91c1c, 0.9);
    g.fillEllipse(x - 2, y - 1, 12, 7);

    // 5 satellite drops at random offsets around the main blob.
    g.fillStyle(0x7f1d1d, 0.9);
    for (let i = 0; i < 5; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 12 + Math.random() * 12;
      const r = 1.5 + Math.random() * 2.5;
      g.fillCircle(x + Math.cos(angle) * dist, y + Math.sin(angle) * dist, r);
    }
    return g;
  }

  /**
   * A single droplet that spurts outward and "lands" on the ground, leaving
   * a tiny stain that fades out a few seconds later.
   */
  private spawnBloodDroplet(
    sx: number,
    sy: number,
    groundY: number,
    baseDepth: number
  ): void {
    const angle = Math.random() * Math.PI * 2;
    const horizDist = 18 + Math.random() * 28;
    const landX = sx + Math.cos(angle) * horizDist;
    // Land near the ground line plus a small vertical jitter.
    const landY = groundY + (Math.random() - 0.5) * 10;
    const apexY = sy - 16 - Math.random() * 14;

    const drop = this.scene.add.rectangle(sx, sy, 3, 3, 0x991b1b, 1);
    drop.setDepth(baseDepth + 5);

    // Phase 1: rise + travel outward (~180ms).
    this.scene.tweens.add({
      targets: drop,
      x: sx + (landX - sx) * 0.55,
      y: apexY,
      duration: 180,
      ease: Phaser.Math.Easing.Quadratic.Out,
      onComplete: () => {
        // Phase 2: fall to the ground.
        this.scene.tweens.add({
          targets: drop,
          x: landX,
          y: landY,
          duration: 240,
          ease: Phaser.Math.Easing.Quadratic.In,
          onComplete: () => {
            drop.destroy();
            // Leave a tiny lingering stain at the landing point.
            const stain = this.scene.add.graphics();
            stain.setDepth(baseDepth - 1);
            stain.fillStyle(0x7f1d1d, 0.85);
            stain.fillCircle(landX, landY, 2 + Math.random() * 1.5);
            this.scene.tweens.add({
              targets: stain,
              alpha: 0,
              delay: 2000,
              duration: 1500,
              onComplete: () => stain.destroy(),
            });
          },
        });
      },
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private render(): void {
    this.container?.destroy();
    if (!this.openFor) return;

    const cam = this.scene.cameras.main;
    const W = cam.width;
    const H = cam.height;
    const panelW = Math.min(W - 40, 460);
    // Menu view gained a ~50px header (status + tool detail) when E was
    // unified into Space, so we need a bit more height.
    const panelH = this.view === "plan" ? 220 : 250;
    const panelX = (W - panelW) / 2;
    const panelY = H - panelH - 16;

    const bg = this.scene.add.graphics();
    bg.fillStyle(0x0d1117, 0.94);
    bg.lineStyle(2, 0x60a5fa, 0.92);
    bg.fillRoundedRect(0, 0, panelW, panelH, 6);
    bg.strokeRoundedRect(0, 0, panelW, panelH, 6);

    const objs: Phaser.GameObjects.GameObject[] = [bg];

    if (this.view === "plan") {
      this.renderPlanView(panelW, panelH, objs);
    } else {
      this.renderMenuView(panelW, panelH, objs);
    }

    const container = this.scene.add.container(panelX, panelY, objs);
    container.setScrollFactor(0);
    container.setDepth(layerDepth.UI + 500);
    this.container = container;
  }

  private renderMenuView(
    panelW: number,
    panelH: number,
    objs: Phaser.GameObjects.GameObject[]
  ): void {
    const npc = this.openFor!;
    const name = npc.def.name || npc.def.id;
    const status = npc.def.status ?? "idle";
    const statusColor = STATUS_COLOR_HEX[status];
    const statusLabel = t(`status.${status}`);
    const tool = npc.def.currentTool;
    const detail = npc.def.currentToolDetail;

    // ── Header: colored status dot + agent name (line 1)
    const dot = this.scene.add.graphics();
    dot.fillStyle(statusColor, 1);
    dot.fillCircle(20, 18, 5);
    dot.lineStyle(1, 0x111111, 0.9);
    dot.strokeCircle(20, 18, 5);
    objs.push(dot);
    objs.push(
      this.scene.add.text(32, 10, name, {
        fontSize: "14px",
        fontStyle: "bold",
        color: "#e5e7eb",
      })
    );

    // ── Subheader: status label · tool · detail (line 2)
    let subheader = statusLabel;
    if (tool) subheader += `  ·  ${tool}`;
    if (detail) subheader += `  —  ${detail}`;
    objs.push(
      this.scene.add.text(12, 30, subheader, {
        fontSize: "11px",
        color: "#9ca3af",
        wordWrap: { width: panelW - 24 },
      })
    );

    // ── Divider between header and actions
    const divider = this.scene.add.graphics();
    divider.lineStyle(1, 0x374151, 0.8);
    divider.lineBetween(12, 56, panelW - 12, 56);
    objs.push(divider);

    const actions = this.buildActions().filter((a) => !a.hidden);
    let y = 64;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      const color = a.disabled ? "#6b7280" : "#e5e7eb";
      const accent = a.disabled ? "#4b5563" : "#fbbf24";
      const row = this.scene.add.text(
        12,
        y,
        `[${i + 1}] ${a.label}`,
        { fontSize: "12px", fontStyle: "bold", color: accent }
      );
      const desc = this.scene.add.text(
        34,
        y + 13,
        a.description,
        { fontSize: "10px", color, wordWrap: { width: panelW - 48 } }
      );
      objs.push(row, desc);
      y += 13 + desc.height + 6;
    }

    objs.push(
      this.scene.add.text(12, panelH - 22, "[1–5] Choisir   [Esc] Fermer", {
        fontSize: "11px",
        color: "#86efac",
      })
    );
  }

  private renderPlanView(
    panelW: number,
    panelH: number,
    objs: Phaser.GameObjects.GameObject[]
  ): void {
    const npc = this.openFor!;
    objs.push(
      this.scene.add.text(12, 10, "📋  Plan en attente", {
        fontSize: "13px",
        fontStyle: "bold",
        color: "#60a5fa",
      })
    );

    const plan = (npc.def.pendingPlan ?? "").trim() || "(plan vide)";
    objs.push(
      this.scene.add.text(12, 32, plan, {
        fontSize: "11px",
        color: "#d1d5db",
        wordWrap: { width: panelW - 24 },
        lineSpacing: 3,
      })
    );

    objs.push(
      this.scene.add.text(12, panelH - 22, "[Esc] Retour", {
        fontSize: "11px",
        color: "#86efac",
      })
    );
  }
}
