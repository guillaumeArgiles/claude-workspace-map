import Phaser from "phaser";
import { layerDepth } from "../config/grid";
import { uiBus } from "../services/uiBus";
import { t } from "../../i18n";
import type { NpcInstance } from "../agents/types";

/**
 * Camera-fixed RPG dialogue panel for awaiting_approval interactions.
 *
 * Opens when the player presses E on an NPC that has a pendingPlan or
 * pendingQuestions. Writes the user's choice to the agent's PTY session.
 *
 * Keyboard shortcuts:
 *   Plan:      [Y] approve  [N] reject  [T] open terminal  [Esc] close
 *   Questions: [1–4] pick option          [T] open terminal  [Esc] close
 */
export class RPGApprovalUI {
  private container?: Phaser.GameObjects.Container;
  private openFor?: NpcInstance;
  /** undefined = fetching  |  null = not found  |  string = found */
  private ptyId: string | null | undefined;

  private keyY!: Phaser.Input.Keyboard.Key;
  private keyN!: Phaser.Input.Keyboard.Key;
  private keyT!: Phaser.Input.Keyboard.Key;
  private keyEsc!: Phaser.Input.Keyboard.Key;
  private keyNums!: Phaser.Input.Keyboard.Key[];

  constructor(private readonly scene: Phaser.Scene) {}

  init(): void {
    const kb = this.scene.input.keyboard!;
    this.keyY   = kb.addKey(Phaser.Input.Keyboard.KeyCodes.Y);
    this.keyN   = kb.addKey(Phaser.Input.Keyboard.KeyCodes.N);
    this.keyT   = kb.addKey(Phaser.Input.Keyboard.KeyCodes.T);
    this.keyEsc = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.keyNums = [
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.ONE),
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.TWO),
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.THREE),
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.FOUR),
    ];
  }

  isOpen(): boolean {
    return this.openFor !== undefined;
  }

  get openNpc(): NpcInstance | undefined {
    return this.openFor;
  }

  open(npc: NpcInstance): void {
    const wasOpen = this.openFor !== undefined;
    this.close();
    this.openFor = npc;
    this.ptyId = undefined;
    this.render(npc);
    if (!wasOpen) uiBus.emit("modal_open_changed", { open: true });
    void this.fetchPty(npc.def.id);
  }

  close(): void {
    const wasOpen = this.openFor !== undefined;
    this.container?.destroy();
    this.container = undefined;
    this.openFor = undefined;
    this.ptyId = undefined;
    if (wasOpen) uiBus.emit("modal_open_changed", { open: false });
  }

  update(): void {
    if (!this.openFor) return;

    if (Phaser.Input.Keyboard.JustDown(this.keyEsc)) {
      this.close();
      return;
    }

    const npc = this.openFor;

    // Auto-close when the agent is no longer waiting
    if (npc.def.status !== "awaiting_approval") {
      this.close();
      return;
    }

    if (npc.def.pendingPlan) {
      if (Phaser.Input.Keyboard.JustDown(this.keyY)) {
        void this.writeToPty("y\r");
        this.close();
        return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keyN)) {
        void this.writeToPty("n\r");
        this.close();
        return;
      }
    } else if (npc.def.pendingQuestions?.length) {
      const optCount = Math.min(npc.def.pendingQuestions[0].options.length, 4);
      for (let i = 0; i < optCount; i++) {
        if (Phaser.Input.Keyboard.JustDown(this.keyNums[i])) {
          void this.writeToPty(`${i + 1}\r`);
          this.close();
          return;
        }
      }
    }

    if (Phaser.Input.Keyboard.JustDown(this.keyT)) {
      uiBus.emit("open_terminal", { sessionId: npc.def.id });
      this.close();
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async fetchPty(sessionId: string): Promise<void> {
    try {
      const res = await fetch(`/api/sessions/by-session/${encodeURIComponent(sessionId)}`);
      const { ptyId } = (await res.json()) as { ptyId: string | null };
      this.ptyId = ptyId;
    } catch {
      this.ptyId = null;
    }
    // Re-render with the updated canInteract state
    if (this.openFor?.def.id === sessionId) {
      this.render(this.openFor);
    }
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
      // ignore — PTY may have closed
    }
  }

  private render(npc: NpcInstance): void {
    this.container?.destroy();

    const cam = this.scene.cameras.main;
    const W = cam.width;
    const H = cam.height;
    const panelW = Math.min(W - 40, 620);
    const panelH = 184;
    const panelX = (W - panelW) / 2;
    const panelY = H - panelH - 16;

    const canInteract = this.ptyId != null;
    const loading = this.ptyId === undefined;

    const bg = this.scene.add.graphics();
    bg.fillStyle(0x0d1117, 0.94);
    bg.lineStyle(2, 0xe0a840, 0.92);
    bg.fillRoundedRect(0, 0, panelW, panelH, 6);
    bg.strokeRoundedRect(0, 0, panelW, panelH, 6);

    const objs: Phaser.GameObjects.GameObject[] = [bg];

    if (npc.def.pendingPlan) {
      this.renderPlan(npc, panelW, panelH, canInteract, loading, objs);
    } else if (npc.def.pendingQuestions?.length) {
      this.renderQuestions(npc, panelW, panelH, canInteract, loading, objs);
    }

    const container = this.scene.add.container(panelX, panelY, objs);
    container.setScrollFactor(0);
    container.setDepth(layerDepth.UI + 500);
    this.container = container;
  }

  private renderPlan(
    npc: NpcInstance,
    panelW: number,
    panelH: number,
    canInteract: boolean,
    loading: boolean,
    objs: Phaser.GameObjects.GameObject[]
  ): void {
    const name = npc.def.name || npc.def.id;
    objs.push(
      this.scene.add.text(12, 10, `📋  ${name}`, {
        fontSize: "13px",
        fontStyle: "bold",
        color: "#e0a840",
      })
    );

    const preview = (npc.def.pendingPlan ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join("\n");
    objs.push(
      this.scene.add.text(12, 32, preview || t("approval.empty_plan"), {
        fontSize: "11px",
        color: "#d1d5db",
        wordWrap: { width: panelW - 24 },
        lineSpacing: 3,
      })
    );

    objs.push(this.makeFooter(panelW, panelH, canInteract, loading, "plan"));
  }

  private renderQuestions(
    npc: NpcInstance,
    panelW: number,
    panelH: number,
    canInteract: boolean,
    loading: boolean,
    objs: Phaser.GameObjects.GameObject[]
  ): void {
    const q = npc.def.pendingQuestions![0];
    objs.push(
      this.scene.add.text(12, 10, `❓  ${q.question}`, {
        fontSize: "13px",
        fontStyle: "bold",
        color: "#e0a840",
        wordWrap: { width: panelW - 24 },
      })
    );

    let optY = 36;
    for (let i = 0; i < Math.min(q.options.length, 4); i++) {
      const opt = q.options[i];
      const row = this.scene.add.text(
        12,
        optY,
        `[${i + 1}]  ${opt.label}${opt.description ? `  —  ${opt.description}` : ""}`,
        { fontSize: "11px", color: "#d1d5db", wordWrap: { width: panelW - 24 } }
      );
      objs.push(row);
      optY += row.height + 4;
    }

    objs.push(this.makeFooter(panelW, panelH, canInteract, loading, "questions"));
  }

  private makeFooter(
    panelW: number,
    panelH: number,
    canInteract: boolean,
    loading: boolean,
    kind: "plan" | "questions"
  ): Phaser.GameObjects.Text {
    let msg: string;
    let color: string;
    if (loading) {
      msg = t("approval.footer.connecting");
      color = "#6b7280";
    } else if (canInteract) {
      msg =
        kind === "plan"
          ? t("approval.footer.plan")
          : t("approval.footer.questions");
      color = "#86efac";
    } else {
      msg = t("approval.footer.external");
      color = "#fbbf24";
    }
    return this.scene.add.text(12, panelH - 22, msg, {
      fontSize: "11px",
      color,
      wordWrap: { width: panelW - 24 },
    });
  }
}
