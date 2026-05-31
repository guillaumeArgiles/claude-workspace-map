import Phaser from "phaser";
import { layerDepth } from "../config/grid";
import { uiBus } from "../services/uiBus";
import { t } from "../../i18n";
import type { NativeRoutine, Routine } from "../../../shared/routine-schema";

/**
 * Up-render text @ DPR + downscale → crisp under pixelArt:true Phaser config.
 * Same helper pattern used by RPGAgentMenuUI / DialogueUI.
 */
const TEXT_RES = Math.max(2, Math.ceil(globalThis.devicePixelRatio || 1));

/** Augmented Routine with the nextRunAt the server pre-computed for us. */
type RoutineWithNext = Routine & { nextRunAt?: number | null };

interface RoutinesPayload {
  fleet: RoutineWithNext[];
  native: NativeRoutine[];
}

type ViewMode = "loading" | "list" | "error";

/**
 * Camera-fixed panel for managing FleetView routines and viewing
 * Claude-native scheduled tasks. Opened by walking up to the wooden
 * plank in the garden and pressing Space.
 *
 * Phase 3 scope : list view only (FleetView + native sections, no CRUD).
 * Phase 4 will add create / edit / delete sub-views.
 */
export class RPGRoutinesUI {
  private container?: Phaser.GameObjects.Container;
  private isOpenFlag = false;
  private view: ViewMode = "loading";
  private payload: RoutinesPayload = { fleet: [], native: [] };
  private errorMessage?: string;

  private keyEsc!: Phaser.Input.Keyboard.Key;

  constructor(private readonly scene: Phaser.Scene) {}

  init(): void {
    const kb = this.scene.input.keyboard!;
    this.keyEsc = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
  }

  isOpen(): boolean {
    return this.isOpenFlag;
  }

  open(): void {
    if (this.isOpenFlag) return;
    this.isOpenFlag = true;
    this.view = "loading";
    this.payload = { fleet: [], native: [] };
    this.errorMessage = undefined;
    this.render();
    uiBus.emit("modal_open_changed", { open: true });
    void this.fetchRoutines();
  }

  close(): void {
    if (!this.isOpenFlag) return;
    this.container?.destroy();
    this.container = undefined;
    this.isOpenFlag = false;
    uiBus.emit("modal_open_changed", { open: false });
  }

  update(): void {
    if (!this.isOpenFlag) return;
    if (Phaser.Input.Keyboard.JustDown(this.keyEsc)) {
      this.close();
    }
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  private async fetchRoutines(): Promise<void> {
    try {
      const res = await fetch("/api/routines");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RoutinesPayload;
      if (!this.isOpenFlag) return;
      this.payload = data;
      this.view = "list";
      this.render();
    } catch (err) {
      if (!this.isOpenFlag) return;
      this.view = "error";
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.render();
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private render(): void {
    this.container?.destroy();
    const cam = this.scene.cameras.main;
    const W = cam.width;
    const H = cam.height;
    const panelW = Math.min(W - 60, 640);
    const panelH = Math.min(H - 80, 540);
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    const bg = this.scene.add.graphics();
    bg.fillStyle(0x0d1117, 0.96);
    bg.lineStyle(2, 0xfbbf24, 0.92); // golden border to echo "scheduled tasks"
    bg.fillRoundedRect(0, 0, panelW, panelH, 8);
    bg.strokeRoundedRect(0, 0, panelW, panelH, 8);

    const objs: Phaser.GameObjects.GameObject[] = [bg];

    // Header
    objs.push(
      this.scene.add.text(16, 12, t("routines.title"), {
        fontSize: "16px",
        fontStyle: "bold",
        color: "#fbbf24",
        resolution: TEXT_RES,
      })
    );

    if (this.view === "loading") {
      objs.push(
        this.scene.add.text(16, 56, t("routines.loading"), {
          fontSize: "12px",
          color: "#9ca3af",
          resolution: TEXT_RES,
        })
      );
    } else if (this.view === "error") {
      objs.push(
        this.scene.add.text(16, 56, `${t("routines.error")}: ${this.errorMessage}`, {
          fontSize: "12px",
          color: "#ef4444",
          wordWrap: { width: panelW - 32 },
          resolution: TEXT_RES,
        })
      );
    } else {
      this.renderList(panelW, panelH, objs);
    }

    // Footer
    const footer =
      this.view === "list"
        ? t("routines.footer.phase3")
        : t("routines.footer.close");
    objs.push(
      this.scene.add.text(16, panelH - 24, footer, {
        fontSize: "11px",
        color: "#86efac",
        resolution: TEXT_RES,
      })
    );

    const container = this.scene.add.container(panelX, panelY, objs);
    container.setScrollFactor(0);
    container.setDepth(layerDepth.UI + 500);
    this.container = container;
  }

  private renderList(
    panelW: number,
    panelH: number,
    objs: Phaser.GameObjects.GameObject[]
  ): void {
    let y = 44;

    // ── FleetView section
    objs.push(
      this.scene.add.text(16, y, t("routines.section.fleet"), {
        fontSize: "13px",
        fontStyle: "bold",
        color: "#60a5fa",
        resolution: TEXT_RES,
      })
    );
    y += 22;

    if (this.payload.fleet.length === 0) {
      objs.push(
        this.scene.add.text(28, y, t("routines.empty.fleet"), {
          fontSize: "11px",
          color: "#6b7280",
          fontStyle: "italic",
          resolution: TEXT_RES,
        })
      );
      y += 24;
    } else {
      for (const routine of this.payload.fleet) {
        y = this.renderFleetRow(routine, 28, y, panelW - 44, objs);
      }
    }

    y += 12;

    // ── Native section
    objs.push(
      this.scene.add.text(16, y, t("routines.section.native"), {
        fontSize: "13px",
        fontStyle: "bold",
        color: "#a78bfa",
        resolution: TEXT_RES,
      })
    );
    y += 22;

    if (this.payload.native.length === 0) {
      objs.push(
        this.scene.add.text(28, y, t("routines.empty.native"), {
          fontSize: "11px",
          color: "#6b7280",
          fontStyle: "italic",
          resolution: TEXT_RES,
        })
      );
    } else {
      // Cap at 6 native entries to avoid scrolling for now (phase 5 can add it).
      const visible = this.payload.native.slice(0, 6);
      for (const routine of visible) {
        y = this.renderNativeRow(routine, 28, y, panelW - 44, objs);
        if (y > panelH - 60) break; // stop if overflowing
      }
      const hidden = this.payload.native.length - visible.length;
      if (hidden > 0) {
        objs.push(
          this.scene.add.text(28, y, t("routines.more_hidden", { count: hidden }), {
            fontSize: "10px",
            color: "#6b7280",
            fontStyle: "italic",
            resolution: TEXT_RES,
          })
        );
      }
    }
  }

  private renderFleetRow(
    r: RoutineWithNext,
    x: number,
    y: number,
    width: number,
    objs: Phaser.GameObjects.GameObject[]
  ): number {
    const statusColor = r.enabled ? "#22c55e" : "#6b7280";
    const dot = this.scene.add.graphics();
    dot.fillStyle(Number.parseInt(statusColor.slice(1), 16), 1);
    dot.fillCircle(x, y + 7, 4);
    dot.lineStyle(1, 0x111111, 0.9);
    dot.strokeCircle(x, y + 7, 4);
    objs.push(dot);

    objs.push(
      this.scene.add.text(x + 12, y, r.name, {
        fontSize: "12px",
        fontStyle: "bold",
        color: "#e5e7eb",
        resolution: TEXT_RES,
      })
    );

    const meta = this.fleetMetaLine(r);
    objs.push(
      this.scene.add.text(x + 12, y + 15, meta, {
        fontSize: "10px",
        color: "#9ca3af",
        wordWrap: { width: width - 12 },
        resolution: TEXT_RES,
      })
    );
    return y + 36;
  }

  private renderNativeRow(
    r: NativeRoutine,
    x: number,
    y: number,
    width: number,
    objs: Phaser.GameObjects.GameObject[]
  ): number {
    const sourceLabel = t(`routines.source.${r.source}`);
    objs.push(
      this.scene.add.text(x, y, `▸ ${r.name}`, {
        fontSize: "12px",
        color: "#d1d5db",
        resolution: TEXT_RES,
      })
    );
    const cron = r.cronExpression ? `${r.cronExpression}` : t("routines.adhoc");
    const enabledText = r.enabled === false ? " · " + t("routines.disabled") : "";
    objs.push(
      this.scene.add.text(x + 12, y + 14, `${sourceLabel} · ${cron}${enabledText}`, {
        fontSize: "10px",
        color: "#6b7280",
        wordWrap: { width: width - 12 },
        resolution: TEXT_RES,
      })
    );
    return y + 32;
  }

  private fleetMetaLine(r: RoutineWithNext): string {
    const parts: string[] = [];
    parts.push(r.cronExpression);
    if (typeof r.nextRunAt === "number") {
      parts.push(t("routines.next_run", { when: formatRelative(r.nextRunAt) }));
    }
    if (r.lastRunAt) {
      parts.push(t("routines.last_run", { when: formatRelative(r.lastRunAt) }));
    }
    if (!r.enabled) parts.push(t("routines.disabled"));
    return parts.join("  ·  ");
  }
}

// ── Relative time helper ──────────────────────────────────────────────────────

/**
 * "in 5 min" / "il y a 3h" — keeps the UI light without pulling in a date lib.
 * Returns FR-flavoured strings (matches the user's locale; could be i18n'd
 * later via t("relative.*") if EN/ES users complain).
 */
function formatRelative(ts: number): string {
  const diffSec = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const unit =
    abs < 60
      ? { divisor: 1, suffix: "s" }
      : abs < 3600
        ? { divisor: 60, suffix: "min" }
        : abs < 86_400
          ? { divisor: 3600, suffix: "h" }
          : { divisor: 86_400, suffix: "j" };
  const value = Math.round(abs / unit.divisor);
  return diffSec >= 0 ? `dans ${value}${unit.suffix}` : `il y a ${value}${unit.suffix}`;
}
