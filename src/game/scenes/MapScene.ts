import Phaser from "phaser";
import { GRID, layerDepth } from "../config/grid";
import { uiBus, type UiEvents } from "../services/uiBus";
import {
  TEACHER_SPRITES,
  STUDENT_SPRITES,
} from "../../../shared/agent-sprites";
import { CAMERA_ZOOM } from "../world/gameplayConstants";
import { NpcManager } from "../agents/NpcManager";
import { AgentSyncer } from "../agents/AgentSyncer";
import { DialogueUI } from "../ui/DialogueUI";
import { PlayerController } from "../player/PlayerController";

const BACKGROUND_KEY = "workspace-background";

interface CollisionRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

interface CollisionsFile {
  version: string;
  description?: string;
  rects: CollisionRect[];
}

interface DrawnRect {
  rect: CollisionRect;
  graphic: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  zone: Phaser.GameObjects.Zone;
}

export class MapScene extends Phaser.Scene {
  private previewGrid = false;
  private debugMode = false;
  private mouseLabel?: Phaser.GameObjects.Text;
  private helpLabel?: Phaser.GameObjects.Text;
  private obstacles!: Phaser.Physics.Arcade.StaticGroup;

  // Character + UI managers. Wire-up order matters: the syncer needs the
  // dialogue + npc manager, and the player controller needs the syncer's
  // lookups.
  private npcManager = new NpcManager(this);
  private dialogue = new DialogueUI(this);
  private agentSyncer = new AgentSyncer(this, this.npcManager, this.dialogue, {
    onStatusChange: (text) => this.statusText?.setText(text),
  });
  private playerController = new PlayerController(this, this.npcManager, this.dialogue, {
    findNpcById: (id) => this.agentSyncer.findNpcById(id),
    findHouseForNpc: (npc) => this.agentSyncer.findHouseForNpc(npc),
  });
  private statusText?: Phaser.GameObjects.Text;

  // Drawing state (debug mode)
  private drawStart?: { x: number; y: number };
  private drawingPreview?: Phaser.GameObjects.Graphics;
  private drawnRects: DrawnRect[] = [];

  constructor() {
    super("MapScene");
  }

  init(): void {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      this.previewGrid = params.has("grid");
      this.debugMode = params.has("debug");
    }
  }

  preload(): void {
    this.load.image(BACKGROUND_KEY, "/assets/background.png");
    this.load.json("collisions", "/map-spec/collisions.json");

    // Player + all teacher/student sprite candidates. Loaded as plain images;
    // sliced into 3×4 RPG Maker sheets in create(). Missing files are tolerated.
    this.load.image("player_image", "/assets/sprites/player.png");
    for (const src of [...TEACHER_SPRITES, ...STUDENT_SPRITES]) {
      this.load.image(`${src}_image`, `/assets/sprites/${src}.png`);
    }
    this.load.on("loaderror", () => {
      /* sprite may be missing — placeholder will kick in */
    });
  }


  create(): void {
    // Background
    this.add
      .image(0, 0, BACKGROUND_KEY)
      .setOrigin(0, 0)
      .setDisplaySize(GRID.width, GRID.height)
      .setDepth(layerDepth.GROUND);

    // Collisions
    const collisions = this.cache.json.get("collisions") as CollisionsFile;
    this.obstacles = this.physics.add.staticGroup();
    for (const rect of collisions.rects) {
      this.addObstacle(rect);
      if (this.debugMode) this.drawDebugRect(rect);
    }

    // Player (PlayerController owns sprite + keyboard + autopilot).
    const player = this.playerController.init({
      x: GRID.width / 2,
      y: GRID.height - 100,
    });
    this.physics.add.collider(player, this.obstacles);

    // Camera: smooth follow + slight zoom, clamped to the map.
    this.cameras.main.setBounds(0, 0, GRID.width, GRID.height);
    this.cameras.main.setZoom(CAMERA_ZOOM);
    this.cameras.main.startFollow(player, true, 0.12, 0.12);

    // NPCs: NpcManager owns the physics group and the colliders.
    this.npcManager.init({ player, obstacles: this.obstacles });

    // Dialogue UI (prompt + bubble container).
    this.dialogue.init();

    // HUD: top-left status line showing connection / agent count.
    this.statusText = this.add
      .text(8, 8, "Connecting to /api/events…", {
        fontSize: "12px",
        color: "#ffffff",
        backgroundColor: "#000000aa",
        padding: { x: 6, y: 3 },
      })
      .setScrollFactor(0)
      .setDepth(layerDepth.UI);

    this.agentSyncer.start();

    if (this.previewGrid) this.drawPreviewGrid();
    if (this.debugMode) {
      this.enableDebugOverlay();
      this.enableDrawingTool();
    }

    // UI bus → click in the sidebar pops the bounce + sends the player walking.
    const onHighlight = (data: UiEvents["highlight_agent"]) =>
      this.playerController.highlightAgent(data.id);
    uiBus.on("highlight_agent", onHighlight);

    const cleanup = () => {
      this.agentSyncer.stop();
      uiBus.off("highlight_agent", onHighlight);
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, cleanup);
    this.events.once(Phaser.Scenes.Events.DESTROY, cleanup);
  }


  update(): void {
    this.playerController.update();

    // NPC AI + overlays via the manager.
    const now = this.time.now;
    this.npcManager.updateAll(now, this.dialogue.openNpc);

    // Sub-agent despawn timer (lifecycle of student NPCs).
    this.agentSyncer.tickDespawns(now);
  }

  /**
   * Build walk/idle animations for a character. Uses the real sprite sheet at
   * /assets/sprites/<id>.png if it loaded, otherwise generates a programmatic
   * 2-frame placeholder with a simple leg-swap walk cycle.
   * Returns the texture key the sprite should start with.
   */
  // ----- Obstacles -----

  private addObstacle(rect: CollisionRect): Phaser.GameObjects.Zone {
    const zone = this.add.zone(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w, rect.h);
    this.physics.add.existing(zone, true);
    this.obstacles.add(zone);
    return zone;
  }

  // ----- Debug overlay -----

  private enableDebugOverlay(): void {
    this.physics.world.drawDebug = true;
    this.physics.world.debugGraphic = this.add.graphics().setDepth(layerDepth.UI - 1);

    this.mouseLabel = this.add
      .text(8, GRID.height - 22, "x: -, y: -", {
        fontSize: "12px",
        color: "#ffffff",
        backgroundColor: "#000000aa",
        padding: { x: 6, y: 3 },
      })
      .setScrollFactor(0)
      .setDepth(layerDepth.UI + 1);

    this.helpLabel = this.add
      .text(8, 8, "DEBUG · drag = draw rect (auto-copy) · X = undo · R = reset", {
        fontSize: "12px",
        color: "#ffffff",
        backgroundColor: "#000000aa",
        padding: { x: 6, y: 3 },
      })
      .setScrollFactor(0)
      .setDepth(layerDepth.UI + 1);

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      this.mouseLabel?.setText(
        `x: ${Math.round(pointer.worldX)}, y: ${Math.round(pointer.worldY)}`
      );
    });
  }

  // ----- Drawing tool -----

  private enableDrawingTool(): void {
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.drawStart = { x: Math.round(p.worldX), y: Math.round(p.worldY) };
      this.drawingPreview = this.add.graphics().setDepth(layerDepth.UI - 1);
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.drawStart || !this.drawingPreview) return;
      const r = this.rectFromDrag(p);
      this.drawingPreview.clear();
      this.drawingPreview.fillStyle(0xffff00, 0.3);
      this.drawingPreview.fillRect(r.x, r.y, r.w, r.h);
      this.drawingPreview.lineStyle(2, 0xffff00, 1);
      this.drawingPreview.strokeRect(r.x, r.y, r.w, r.h);
    });

    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (!this.drawStart) return;
      const r = this.rectFromDrag(p);
      this.drawingPreview?.destroy();
      this.drawingPreview = undefined;
      this.drawStart = undefined;
      if (r.w < 6 || r.h < 6) return;

      const id = `new_${this.drawnRects.length + 1}`;
      const rect: CollisionRect = { id, ...r, label: id };
      this.commitDrawnRect(rect);
      this.copyDrawnAsJson();
    });

    this.input.keyboard!.on("keydown-X", () => this.undoLastDrawn());
    this.input.keyboard!.on("keydown-R", () => this.resetDrawn());
  }

  private rectFromDrag(p: Phaser.Input.Pointer): { x: number; y: number; w: number; h: number } {
    const x1 = this.drawStart!.x;
    const y1 = this.drawStart!.y;
    const x2 = Math.round(p.worldX);
    const y2 = Math.round(p.worldY);
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
    };
  }

  private commitDrawnRect(rect: CollisionRect): void {
    const g = this.add.graphics().setDepth(layerDepth.UI - 1);
    g.fillStyle(0xffff00, 0.25);
    g.fillRect(rect.x, rect.y, rect.w, rect.h);
    g.lineStyle(2, 0xffaa00, 1);
    g.strokeRect(rect.x, rect.y, rect.w, rect.h);

    const label = this.add
      .text(rect.x + 4, rect.y + 4, `${rect.id}\n${rect.x},${rect.y} ${rect.w}×${rect.h}`, {
        fontSize: "11px",
        color: "#222",
        backgroundColor: "#ffff00cc",
        padding: { x: 3, y: 1 },
      })
      .setDepth(layerDepth.UI);

    const zone = this.addObstacle(rect);
    this.drawnRects.push({ rect, graphic: g, label, zone });
    console.log("[debug] new rect:", JSON.stringify(rect));
  }

  private copyDrawnAsJson(): void {
    if (this.drawnRects.length === 0) return;
    const lines = this.drawnRects.map(
      ({ rect: r }) =>
        `    { "id": "${r.id}", "x": ${r.x}, "y": ${r.y}, "w": ${r.w}, "h": ${r.h}, "label": "${r.label}" }`
    );
    const json = lines.join(",\n");
    navigator.clipboard.writeText(json).then(
      () => {
        console.log(`[debug] copied ${this.drawnRects.length} rect(s) to clipboard:\n${json}`);
        this.helpLabel?.setText(
          `Copied ${this.drawnRects.length} rect(s) — paste into collisions.json`
        );
        this.time.delayedCall(2000, () => this.resetHelpLabel());
      },
      () => {
        console.log("[debug] clipboard failed, JSON in console:\n" + json);
      }
    );
  }

  private undoLastDrawn(): void {
    const last = this.drawnRects.pop();
    if (!last) return;
    last.graphic.destroy();
    last.label.destroy();
    last.zone.destroy();
  }

  private resetDrawn(): void {
    while (this.drawnRects.length) this.undoLastDrawn();
  }

  private resetHelpLabel(): void {
    this.helpLabel?.setText(
      "DEBUG · drag = draw rect (auto-copy) · X = undo · R = reset"
    );
  }

  // ----- Misc -----

  private drawDebugRect(rect: CollisionRect): void {
    const g = this.add.graphics();
    g.fillStyle(0xff3344, 0.25);
    g.fillRect(rect.x, rect.y, rect.w, rect.h);
    g.lineStyle(2, 0xff3344, 0.9);
    g.strokeRect(rect.x, rect.y, rect.w, rect.h);
    g.setDepth(layerDepth.UI - 1);

    const label = rect.label ?? rect.id;
    this.add
      .text(rect.x + 6, rect.y + 6, `${label}\n${rect.x},${rect.y}  ${rect.w}×${rect.h}`, {
        fontSize: "11px",
        color: "#ffffff",
        backgroundColor: "#00000088",
      })
      .setDepth(layerDepth.UI);
  }

  private drawPreviewGrid(): void {
    const g = this.add.graphics();
    g.lineStyle(1, 0xffffff, 0.18);
    for (let c = 0; c <= GRID.cols; c++) {
      g.lineBetween(c * GRID.cellSize, 0, c * GRID.cellSize, GRID.height);
    }
    for (let r = 0; r <= GRID.rows; r++) {
      g.lineBetween(0, r * GRID.cellSize, GRID.width, r * GRID.cellSize);
    }
    g.setDepth(layerDepth.UI);
  }
}
