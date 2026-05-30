import Phaser from "phaser";
import type { NpcManager } from "../agents/NpcManager";
import type { NpcInstance } from "../agents/types";
import { uiBus } from "./uiBus";

/**
 * Bridges DOM file drag-and-drop with the Phaser scene: drop a file onto an
 * NPC sprite to inject its absolute path into that agent's PTY (and open the
 * terminal). Highlights the NPC under the cursor while dragging.
 *
 * Path resolution: `file.path` is only populated in legacy Electron builds.
 * In a plain browser the only accessible field is `file.name` — we use it as
 * a fallback and warn in the console so the user knows full paths are an
 * Electron-only feature for now.
 */
export class DragDropController {
  private canvas: HTMLCanvasElement | null = null;
  private hoveredNpc: NpcInstance | null = null;
  private boundDragOver = (e: DragEvent) => this.onDragOver(e);
  private boundDragLeave = (e: DragEvent) => this.onDragLeave(e);
  private boundDrop = (e: DragEvent) => this.onDrop(e);

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly npcManager: NpcManager
  ) {}

  init(): void {
    const canvas = this.scene.game.canvas as HTMLCanvasElement | undefined;
    if (!canvas) return;
    this.canvas = canvas;
    canvas.addEventListener("dragover", this.boundDragOver);
    canvas.addEventListener("dragleave", this.boundDragLeave);
    canvas.addEventListener("drop", this.boundDrop);
  }

  destroy(): void {
    if (!this.canvas) return;
    this.canvas.removeEventListener("dragover", this.boundDragOver);
    this.canvas.removeEventListener("dragleave", this.boundDragLeave);
    this.canvas.removeEventListener("drop", this.boundDrop);
    this.clearHover();
    this.canvas = null;
  }

  private onDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    const npc = this.npcAtClientPoint(e.clientX, e.clientY);
    this.setHover(npc);
  }

  private onDragLeave(e: DragEvent): void {
    // Fires whenever the cursor crosses any inner boundary too — only clear
    // if the cursor actually left the canvas rect.
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    if (
      e.clientX <= rect.left ||
      e.clientX >= rect.right ||
      e.clientY <= rect.top ||
      e.clientY >= rect.bottom
    ) {
      this.clearHover();
    }
  }

  private async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    const npc = this.npcAtClientPoint(e.clientX, e.clientY);
    this.clearHover();
    if (!npc) return;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const p = (f as unknown as { path?: string }).path;
      if (p) {
        paths.push(p);
      } else {
        paths.push(f.name);
        console.warn(
          "[drag-drop] Falling back to file.name — full paths require the Electron build"
        );
      }
    }

    const sessionId = npc.def.id;
    const cwd = npc.def.cwd;
    // Open the terminal first — the sidebar either restores an existing PTY
    // for this cwd or spawns a new one. We then poll the sessions list for a
    // PTY with this cwd. Polling by cwd (not by sessionId) is intentional:
    // the JSONL watcher only links sessionId→PTY on a fresh spawn event, so a
    // PTY opened for an *existing* agent never gets that link — but it does
    // have the right cwd.
    uiBus.emit("open_terminal", { sessionId });
    if (!cwd) {
      console.warn("[drag-drop] NPC has no cwd, cannot resolve PTY");
      return;
    }
    try {
      const ptyId = await waitForPtyForCwd(cwd, 3000);
      if (!ptyId) {
        console.warn("[drag-drop] PTY never came up for cwd", cwd);
        return;
      }
      const text = paths.map(quote).join(" ") + " ";
      await fetch(`/api/sessions/${ptyId}/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      console.error("[drag-drop] write failed", err);
    }
  }

  private npcAtClientPoint(
    clientX: number,
    clientY: number
  ): NpcInstance | null {
    if (!this.canvas) return null;
    const rect = this.canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const cam = this.scene.cameras.main;
    const world = cam.getWorldPoint(localX, localY);
    for (const npc of this.npcManager.npcs) {
      const s = npc.sprite;
      const halfW = (s.displayWidth || s.width || 32) / 2 + 4;
      const halfH = (s.displayHeight || s.height || 32) / 2 + 4;
      if (
        world.x >= s.x - halfW &&
        world.x <= s.x + halfW &&
        world.y >= s.y - halfH &&
        world.y <= s.y + halfH
      ) {
        return npc;
      }
    }
    return null;
  }

  private setHover(npc: NpcInstance | null): void {
    if (npc === this.hoveredNpc) return;
    if (this.hoveredNpc) this.hoveredNpc.sprite.clearTint();
    this.hoveredNpc = npc;
    if (npc) npc.sprite.setTint(0x6366f1);
  }

  private clearHover(): void {
    if (this.hoveredNpc) this.hoveredNpc.sprite.clearTint();
    this.hoveredNpc = null;
  }
}

function quote(p: string): string {
  if (!/[\s'"\\$`]/.test(p)) return p;
  return `'${p.replace(/'/g, "'\\''")}'`;
}

async function waitForPtyForCwd(
  cwd: string,
  timeoutMs: number
): Promise<string | null> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`/api/sessions`);
      if (res.ok) {
        const list = (await res.json()) as {
          id: string;
          cwd: string;
          createdAt: number;
          exitCode?: number | null;
        }[];
        const match = list
          .filter((s) => s.cwd === cwd && s.exitCode == null)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (match) return match.id;
      }
    } catch {
      // network blip — keep polling until deadline
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}
