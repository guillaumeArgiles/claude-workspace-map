import Phaser from "phaser";
import { layerDepth } from "../config/grid";
import { uiBus } from "../services/uiBus";
import { t } from "../../i18n";
import {
  CRON_PRESETS,
  type NativeRoutine,
  type Routine,
} from "../../../shared/routine-schema";

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

type ViewMode =
  | "loading"
  | "list"
  | "error"
  | "create"
  | "edit"
  | "delete-confirm";

/** Editable fields shared by the create/edit form. */
interface FormDraft {
  name: string;
  cronExpression: string;
  prompt: string;
  cwd: string;
  enabled: boolean;
}

const EMPTY_DRAFT: FormDraft = {
  name: "",
  cronExpression: CRON_PRESETS[0]!.value,
  prompt: "",
  cwd: "",
  enabled: true,
};

/**
 * Camera-fixed panel for managing FleetView routines and viewing
 * Claude-native scheduled tasks. Opened by walking up to the wooden
 * plank in the garden and pressing Space.
 *
 * Views :
 *   loading   → spinner while /api/routines resolves
 *   list      → 2 sections (FleetView selectable + Claude read-only)
 *   create    → form to add a routine (DOM inputs overlaid on Phaser)
 *   edit      → same form, prefilled with the selected fleet routine
 *   delete-confirm → Y/N modal for the selected routine
 *   error     → fetch failure
 */
export class RPGRoutinesUI {
  private container?: Phaser.GameObjects.Container;
  /** Phaser-wrapped DOM elements created for the current view. */
  private domNodes: Phaser.GameObjects.DOMElement[] = [];

  private isOpenFlag = false;
  private view: ViewMode = "loading";
  private payload: RoutinesPayload = { fleet: [], native: [] };
  private errorMessage?: string;

  /** Index into payload.fleet — cursor for E / D / arrow nav. */
  private selectedIdx = 0;
  /** Working draft for create / edit forms; null outside those views. */
  private draft: FormDraft | null = null;
  /** Original id when editing — `undefined` when creating. */
  private editingId?: string;

  private keyEsc!: Phaser.Input.Keyboard.Key;
  private keyN!: Phaser.Input.Keyboard.Key;
  private keyE!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private keyY!: Phaser.Input.Keyboard.Key;
  private keyDown!: Phaser.Input.Keyboard.Key;
  private keyUp!: Phaser.Input.Keyboard.Key;

  constructor(private readonly scene: Phaser.Scene) {}

  init(): void {
    const kb = this.scene.input.keyboard!;
    this.keyEsc = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);
    this.keyN = kb.addKey(Phaser.Input.Keyboard.KeyCodes.N);
    this.keyE = kb.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.keyD = kb.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keyY = kb.addKey(Phaser.Input.Keyboard.KeyCodes.Y);
    this.keyDown = kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN);
    this.keyUp = kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP);
    // Form Enter / Cmd+Enter are handled by the DOM elements directly,
    // not by Phaser key listeners.
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
    this.selectedIdx = 0;
    this.draft = null;
    this.editingId = undefined;
    this.render();
    uiBus.emit("modal_open_changed", { open: true });
    void this.fetchRoutines();
  }

  close(): void {
    if (!this.isOpenFlag) return;
    this.destroyView();
    this.isOpenFlag = false;
    uiBus.emit("modal_open_changed", { open: false });
  }

  // ── Per-frame key dispatch ───────────────────────────────────────────────

  update(): void {
    if (!this.isOpenFlag) return;
    // Esc is universal — always available, takes back to list or closes.
    if (Phaser.Input.Keyboard.JustDown(this.keyEsc)) {
      this.onEscape();
      return;
    }
    switch (this.view) {
      case "list":
        this.updateListInput();
        break;
      case "create":
      case "edit":
        // Form keys (Enter to submit, Tab to nav) are handled by the DOM
        // inputs themselves. Nothing for Phaser to do beyond Esc.
        break;
      case "delete-confirm":
        if (Phaser.Input.Keyboard.JustDown(this.keyY)) {
          void this.commitDelete();
        }
        break;
    }
  }

  private onEscape(): void {
    if (this.view === "create" || this.view === "edit" || this.view === "delete-confirm") {
      this.view = "list";
      this.draft = null;
      this.editingId = undefined;
      this.render();
    } else {
      this.close();
    }
  }

  private updateListInput(): void {
    const fleet = this.payload.fleet;
    if (fleet.length > 0) {
      if (Phaser.Input.Keyboard.JustDown(this.keyDown)) {
        this.selectedIdx = (this.selectedIdx + 1) % fleet.length;
        this.render();
        return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keyUp)) {
        this.selectedIdx = (this.selectedIdx - 1 + fleet.length) % fleet.length;
        this.render();
        return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keyE)) {
        this.startEdit(fleet[this.selectedIdx]);
        return;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keyD)) {
        this.view = "delete-confirm";
        this.render();
        return;
      }
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyN)) {
      this.startCreate();
    }
  }

  // ── Mode transitions ─────────────────────────────────────────────────────

  private startCreate(): void {
    this.draft = { ...EMPTY_DRAFT };
    this.editingId = undefined;
    this.view = "create";
    this.render();
  }

  private startEdit(routine: RoutineWithNext): void {
    this.draft = {
      name: routine.name,
      cronExpression: routine.cronExpression,
      prompt: routine.prompt,
      cwd: routine.cwd ?? "",
      enabled: routine.enabled,
    };
    this.editingId = routine.id;
    this.view = "edit";
    this.render();
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  private async fetchRoutines(): Promise<void> {
    try {
      const res = await fetch("/api/routines");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as RoutinesPayload;
      if (!this.isOpenFlag) return;
      this.payload = data;
      if (this.selectedIdx >= data.fleet.length) this.selectedIdx = 0;
      this.view = "list";
      this.render();
    } catch (err) {
      if (!this.isOpenFlag) return;
      this.view = "error";
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.render();
    }
  }

  private async commitForm(): Promise<void> {
    if (!this.draft) return;
    const body = JSON.stringify({
      name: this.draft.name.trim(),
      cronExpression: this.draft.cronExpression.trim(),
      prompt: this.draft.prompt,
      cwd: this.draft.cwd.trim() || undefined,
      enabled: this.draft.enabled,
    });
    const url = this.editingId
      ? `/api/routines/${encodeURIComponent(this.editingId)}`
      : "/api/routines";
    const method = this.editingId ? "PUT" : "POST";
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        this.errorMessage = payload.error ?? `HTTP ${res.status}`;
        this.view = "error";
        this.render();
        return;
      }
      // Success — back to list, refresh.
      this.draft = null;
      this.editingId = undefined;
      this.view = "loading";
      this.render();
      void this.fetchRoutines();
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.view = "error";
      this.render();
    }
  }

  private async commitDelete(): Promise<void> {
    const routine = this.payload.fleet[this.selectedIdx];
    if (!routine) return;
    try {
      const res = await fetch(`/api/routines/${encodeURIComponent(routine.id)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      this.view = "loading";
      this.selectedIdx = 0;
      this.render();
      void this.fetchRoutines();
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.view = "error";
      this.render();
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  /** Tear down both Phaser objects and any DOM nodes from the previous view. */
  private destroyView(): void {
    this.container?.destroy();
    this.container = undefined;
    for (const node of this.domNodes) node.destroy();
    this.domNodes = [];
  }

  private render(): void {
    this.destroyView();

    const cam = this.scene.cameras.main;
    const W = cam.width;
    const H = cam.height;
    const panelW = Math.min(W - 60, 640);
    const panelH =
      this.view === "create" || this.view === "edit"
        ? Math.min(H - 60, 540)
        : this.view === "delete-confirm"
          ? 200
          : Math.min(H - 80, 540);
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    const bg = this.scene.add.graphics();
    bg.fillStyle(0x0d1117, 0.96);
    bg.lineStyle(2, 0xfbbf24, 0.92);
    bg.fillRoundedRect(0, 0, panelW, panelH, 8);
    bg.strokeRoundedRect(0, 0, panelW, panelH, 8);

    const objs: Phaser.GameObjects.GameObject[] = [bg];

    // Header
    const titleKey =
      this.view === "create"
        ? "routines.title.create"
        : this.view === "edit"
          ? "routines.title.edit"
          : this.view === "delete-confirm"
            ? "routines.title.delete"
            : "routines.title";
    objs.push(
      this.scene.add.text(16, 12, t(titleKey), {
        fontSize: "16px",
        fontStyle: "bold",
        color: "#fbbf24",
        resolution: TEXT_RES,
      })
    );

    switch (this.view) {
      case "loading":
        objs.push(
          this.scene.add.text(16, 56, t("routines.loading"), {
            fontSize: "12px",
            color: "#9ca3af",
            resolution: TEXT_RES,
          })
        );
        break;
      case "error":
        objs.push(
          this.scene.add.text(16, 56, `${t("routines.error")}: ${this.errorMessage}`, {
            fontSize: "12px",
            color: "#ef4444",
            wordWrap: { width: panelW - 32 },
            resolution: TEXT_RES,
          })
        );
        break;
      case "list":
        this.renderList(panelW, panelH, objs);
        break;
      case "create":
      case "edit":
        this.renderForm(panelW, panelH, panelX, panelY, objs);
        break;
      case "delete-confirm":
        this.renderDeleteConfirm(panelW, panelH, objs);
        break;
    }

    // Footer
    const footer = this.footerKey();
    objs.push(
      this.scene.add.text(16, panelH - 24, t(footer), {
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

  private footerKey(): string {
    switch (this.view) {
      case "create":
      case "edit":
        return "routines.footer.form";
      case "delete-confirm":
        return "routines.footer.delete";
      case "list":
        return this.payload.fleet.length > 0
          ? "routines.footer.list_with_selection"
          : "routines.footer.list_empty";
      default:
        return "routines.footer.close";
    }
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
      for (let i = 0; i < this.payload.fleet.length; i++) {
        y = this.renderFleetRow(
          this.payload.fleet[i],
          i === this.selectedIdx,
          28,
          y,
          panelW - 44,
          objs
        );
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
      const visible = this.payload.native.slice(0, 6);
      for (const routine of visible) {
        y = this.renderNativeRow(routine, 28, y, panelW - 44, objs);
        if (y > panelH - 60) break;
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
    selected: boolean,
    x: number,
    y: number,
    width: number,
    objs: Phaser.GameObjects.GameObject[]
  ): number {
    // Highlight bar when this row is the keyboard cursor.
    if (selected) {
      const hl = this.scene.add.graphics();
      hl.fillStyle(0x1e3a5f, 0.55);
      hl.fillRoundedRect(x - 8, y - 4, width + 12, 38, 4);
      objs.push(hl);
    }

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
        color: selected ? "#fbbf24" : "#e5e7eb",
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

  // ── Form rendering (create / edit) ───────────────────────────────────────

  /**
   * Renders the create/edit form. Labels and panel chrome are pure Phaser;
   * the actual text inputs and selects are HTML DOM elements positioned
   * over the corresponding form fields via `scene.add.dom`.
   *
   * The DOM nodes are tracked in `this.domNodes` and destroyed by
   * `destroyView()` on view transitions so we never leak orphan inputs.
   */
  private renderForm(
    panelW: number,
    panelH: number,
    panelX: number,
    panelY: number,
    objs: Phaser.GameObjects.GameObject[]
  ): void {
    if (!this.draft) return;
    const labelStyle = {
      fontSize: "11px",
      color: "#9ca3af",
      resolution: TEXT_RES,
    } as const;
    const hintStyle = {
      fontSize: "10px",
      color: "#6b7280",
      fontStyle: "italic",
      resolution: TEXT_RES,
    } as const;
    const padX = 20;
    const fieldW = panelW - padX * 2;
    let y = 46;

    // Name
    objs.push(this.scene.add.text(padX, y, t("routines.form.name"), labelStyle));
    y += 14;
    this.addInput(panelX, panelY, padX, y, fieldW, 28, "text", this.draft.name, (v) => {
      if (this.draft) this.draft.name = v;
    });
    y += 36;

    // Frequency preset + cron
    objs.push(this.scene.add.text(padX, y, t("routines.form.frequency"), labelStyle));
    y += 14;
    this.addSelect(
      panelX,
      panelY,
      padX,
      y,
      fieldW,
      28,
      CRON_PRESETS.map((p) => ({ label: p.label, value: p.value })),
      this.draft.cronExpression,
      (v) => {
        if (this.draft) this.draft.cronExpression = v;
        this.syncCronInputValue();
      }
    );
    y += 36;
    objs.push(
      this.scene.add.text(padX, y, t("routines.form.cron_custom"), hintStyle)
    );
    y += 14;
    this.addInput(
      panelX,
      panelY,
      padX,
      y,
      fieldW,
      26,
      "text",
      this.draft.cronExpression,
      (v) => {
        if (this.draft) this.draft.cronExpression = v;
      },
      "routines-cron-input"
    );
    y += 36;

    // Prompt (textarea)
    objs.push(this.scene.add.text(padX, y, t("routines.form.prompt"), labelStyle));
    y += 14;
    this.addTextarea(panelX, panelY, padX, y, fieldW, 110, this.draft.prompt, (v) => {
      if (this.draft) this.draft.prompt = v;
    });
    y += 118;

    // Optional cwd
    objs.push(this.scene.add.text(padX, y, t("routines.form.cwd"), labelStyle));
    y += 14;
    this.addInput(panelX, panelY, padX, y, fieldW, 26, "text", this.draft.cwd, (v) => {
      if (this.draft) this.draft.cwd = v;
    });
    y += 30;

    // Submit/cancel hint already in the footer
    void panelH;
  }

  /** Re-sync the visible cron input's value when the preset select changes. */
  private syncCronInputValue(): void {
    if (!this.draft) return;
    const el = document.getElementById("routines-cron-input") as HTMLInputElement | null;
    if (el) el.value = this.draft.cronExpression;
  }

  private renderDeleteConfirm(
    panelW: number,
    _panelH: number,
    objs: Phaser.GameObjects.GameObject[]
  ): void {
    const routine = this.payload.fleet[this.selectedIdx];
    const name = routine?.name ?? "(?)";
    const msg = t("routines.delete.confirm", { name });
    objs.push(
      this.scene.add.text(20, 56, msg, {
        fontSize: "13px",
        color: "#e5e7eb",
        wordWrap: { width: panelW - 40 },
        resolution: TEXT_RES,
      })
    );
    objs.push(
      this.scene.add.text(20, 104, t("routines.delete.warn"), {
        fontSize: "11px",
        color: "#f87171",
        wordWrap: { width: panelW - 40 },
        resolution: TEXT_RES,
      })
    );
  }

  // ── DOM input helpers ────────────────────────────────────────────────────

  /**
   * Creates an HTML <input>, wraps it via scene.add.dom, positions it inside
   * the modal at (relX, relY) (relative to the panel's top-left corner).
   */
  private addInput(
    panelX: number,
    panelY: number,
    relX: number,
    relY: number,
    width: number,
    height: number,
    type: string,
    value: string,
    onChange: (v: string) => void,
    domId?: string
  ): void {
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    if (domId) input.id = domId;
    Object.assign(input.style, this.inputStyle(width, height));
    input.addEventListener("input", () => onChange(input.value));
    input.addEventListener("keydown", (e) => this.handleFormKey(e));
    // Position : scene.add.dom places the element with its centre at the
    // given world coords. We want the top-left of the input at
    // (panelX + relX, panelY + relY) so offset by width/height halves.
    const cx = panelX + relX + width / 2;
    const cy = panelY + relY + height / 2;
    const dom = this.scene.add.dom(cx, cy, input);
    dom.setScrollFactor(0);
    dom.setDepth(layerDepth.UI + 600);
    this.domNodes.push(dom);
  }

  private addTextarea(
    panelX: number,
    panelY: number,
    relX: number,
    relY: number,
    width: number,
    height: number,
    value: string,
    onChange: (v: string) => void
  ): void {
    const ta = document.createElement("textarea");
    ta.value = value;
    Object.assign(ta.style, {
      ...this.inputStyle(width, height),
      padding: "6px 8px",
      resize: "none",
      lineHeight: "1.35",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
    });
    ta.addEventListener("input", () => onChange(ta.value));
    ta.addEventListener("keydown", (e) => {
      // Cmd/Ctrl+Enter submits; plain Enter inserts newline.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.commitForm();
      } else if (e.key === "Escape") {
        this.onEscape();
      }
    });
    const cx = panelX + relX + width / 2;
    const cy = panelY + relY + height / 2;
    const dom = this.scene.add.dom(cx, cy, ta);
    dom.setScrollFactor(0);
    dom.setDepth(layerDepth.UI + 600);
    this.domNodes.push(dom);
  }

  private addSelect(
    panelX: number,
    panelY: number,
    relX: number,
    relY: number,
    width: number,
    height: number,
    options: ReadonlyArray<{ label: string; value: string }>,
    selected: string,
    onChange: (v: string) => void
  ): void {
    const select = document.createElement("select");
    Object.assign(select.style, this.inputStyle(width, height));
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === selected) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => onChange(select.value));
    select.addEventListener("keydown", (e) => this.handleFormKey(e));
    const cx = panelX + relX + width / 2;
    const cy = panelY + relY + height / 2;
    const dom = this.scene.add.dom(cx, cy, select);
    dom.setScrollFactor(0);
    dom.setDepth(layerDepth.UI + 600);
    this.domNodes.push(dom);
  }

  private inputStyle(width: number, height: number): Partial<CSSStyleDeclaration> {
    return {
      width: `${width}px`,
      height: `${height}px`,
      boxSizing: "border-box",
      padding: "0 8px",
      backgroundColor: "#1a1f27",
      color: "#e5e7eb",
      border: "1px solid #374151",
      borderRadius: "4px",
      fontSize: "12px",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      outline: "none",
    };
  }

  private handleFormKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      void this.commitForm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.onEscape();
    }
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
