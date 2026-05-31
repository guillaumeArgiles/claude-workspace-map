import Phaser from "phaser";
import { GRID, layerDepth } from "../config/grid";
import { t } from "../../i18n";
import { PLAYER_H } from "../world/gameplayConstants";
import type { NpcInstance } from "../agents/types";

/** Up-render text @ DPR + downscale → crisp under pixelArt:true Phaser config. */
const TEXT_RES = Math.max(2, Math.ceil(globalThis.devicePixelRatio || 1));

/**
 * Owns the "Press E to talk" prompt and the speech-bubble container that
 * pops above the NPC we're chatting with. Knows nothing about the player
 * or the agents themselves — callers feed it the current "in range" NPC
 * and ask it to open / close a dialogue.
 */
export class DialogueUI {
  private promptText?: Phaser.GameObjects.Text;
  private bubble?: Phaser.GameObjects.Container;
  private openFor?: NpcInstance;

  constructor(private readonly scene: Phaser.Scene) {}

  init(): void {
    this.promptText = this.scene.add
      .text(0, 0, "", {
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

  /** Whichever NPC the active dialogue is anchored to, if any. */
  get openNpc(): NpcInstance | undefined {
    return this.openFor;
  }

  isOpen(): boolean {
    return this.openFor !== undefined;
  }

  /** Update the floating "[E] talk to …" prompt based on the nearest NPC. */
  setNearest(npc: NpcInstance | undefined): void {
    if (!this.promptText) return;
    if (npc && this.openFor !== npc) {
      // Prefer characterName (just "Liam") over name ("Liam · map") in the
      // floating prompt — the project is already implicit from the map view.
      const shortName = npc.def.characterName ?? npc.def.name;
      const label = npc.def.interactLabel ?? t("dialogue.interact.default", { name: shortName });
      this.promptText.setText(t("dialogue.prompt", { label }));
      this.promptText.setPosition(npc.sprite.x, npc.sprite.y - PLAYER_H);
      this.promptText.setDepth(layerDepth.OVERLAYS + Math.round(npc.sprite.y));
      this.promptText.setVisible(true);
    } else {
      this.promptText.setVisible(false);
    }

    // Walking out of range while talking closes the bubble.
    if (this.openFor && this.openFor !== npc) {
      this.close();
    }
  }

  open(npc: NpcInstance): void {
    this.close();

    const padding = 10;
    const maxWidth = 340;
    const status = npc.def.status;
    const statusLabel = status ? t(`status.${status}`) : "";
    // Teachers: just "Status · Tool" — the project name is already on the
    // house banner. Students: their task description if any, status as fallback.
    let heading: string;
    if (npc.def.role === "student") {
      heading = npc.def.name && !npc.def.name.includes(" · sub")
        ? npc.def.name
        : [statusLabel, npc.def.currentTool].filter(Boolean).join("  ·  ");
    } else {
      heading =
        [statusLabel, npc.def.currentTool].filter(Boolean).join("  ·  ") ||
        npc.def.name;
    }
    const line = npc.def.dialogue;

    const nameText = this.scene.add.text(0, 0, heading, {
      fontSize: "13px",
      fontStyle: "bold",
      color: "#1a202c",
    });
    const bodyText = this.scene.add.text(0, 18, line, {
      fontSize: "12px",
      color: "#1a202c",
      wordWrap: { width: maxWidth },
    });

    const w = Math.max(nameText.width, bodyText.width) + padding * 2;
    const h = nameText.height + bodyText.height + padding * 2 + 4;

    const bg = this.scene.add.graphics();
    bg.fillStyle(0xffffff, 1);
    bg.lineStyle(2, 0x1a202c, 1);
    bg.fillRoundedRect(0, 0, w, h, 8);
    bg.strokeRoundedRect(0, 0, w, h, 8);
    // Tail pointing down at the NPC.
    const tailX = w / 2;
    bg.fillTriangle(tailX - 8, h, tailX + 8, h, tailX, h + 10);
    bg.lineBetween(tailX - 8, h, tailX, h + 10);
    bg.lineBetween(tailX, h + 10, tailX + 8, h);

    nameText.setPosition(padding, padding);
    bodyText.setPosition(padding, padding + nameText.height + 4);

    const container = this.scene.add.container(0, 0, [bg, nameText, bodyText]);
    container.setSize(w, h);
    container.setDepth(layerDepth.OVERLAYS + 10000);
    const bx = Phaser.Math.Clamp(npc.sprite.x - w / 2, 8, GRID.width - w - 8);
    const by = npc.sprite.y - PLAYER_H - h - 12;
    container.setPosition(bx, Math.max(8, by));

    this.bubble = container;
    this.openFor = npc;
    this.promptText?.setVisible(false);
  }

  close(): void {
    this.bubble?.destroy();
    this.bubble = undefined;
    this.openFor = undefined;
  }

  /** Re-open with the latest dialogue line if we're still anchored to npc. */
  refresh(npc: NpcInstance): void {
    if (this.openFor !== npc) return;
    this.open(npc);
  }
}
