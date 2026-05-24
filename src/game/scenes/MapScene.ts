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
import {
  CollisionLayer,
  type CollisionsFile,
} from "../world/CollisionLayer";
import { NavGrid } from "../world/NavGrid";
import { RPGApprovalUI } from "../ui/RPGApprovalUI";

const BACKGROUND_KEY = "workspace-background";

/**
 * Orchestrator scene. Wires the managers together — it owns no domain logic
 * itself, just composition + the HUD status text.
 */
export class MapScene extends Phaser.Scene {
  private previewGrid = false;
  private debugMode = false;
  private statusText?: Phaser.GameObjects.Text;

  // Managers
  private collision = new CollisionLayer(this);
  private npcManager = new NpcManager(this);
  private dialogue = new DialogueUI(this);
  private approvalUI = new RPGApprovalUI(this);
  private agentSyncer = new AgentSyncer(this, this.npcManager, this.dialogue, {
    onStatusChange: (text, severity) => {
      if (!this.statusText) return;
      this.statusText.setText(text);
      // Red background when we lost the stream, neutral otherwise.
      this.statusText.setBackgroundColor(
        severity === "warn" ? "#7f1d1daa" : "#000000aa"
      );
    },
  });
  private playerController = new PlayerController(
    this,
    this.npcManager,
    this.dialogue,
    this.approvalUI,
    {
      findNpcById: (id) => this.agentSyncer.findNpcById(id),
      findHouseForNpc: (npc) => this.agentSyncer.findHouseForNpc(npc),
      onProfessorInteract: () => uiBus.emit("spawn_professor", {}),
    }
  );

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

    // Static collision rectangles.
    const collisions = this.cache.json.get("collisions") as CollisionsFile;
    this.collision.load(collisions, { debug: this.debugMode });

    // Nav grid for A* pathfinding (player click-to-walk + NPC wander targets).
    // 24px cells = 3× finer than the 72px logical grid, fine enough to weave
    // between buildings. Margin ~24px keeps the agent *centre* off walls.
    const navGrid = NavGrid.buildFromObstacles(
      {
        widthPx: GRID.width,
        heightPx: GRID.height,
        cellSize: 24,
        margin: 24,
      },
      this.collision.rects
    );
    this.playerController.setNavGrid(navGrid);
    this.npcManager.setNavGrid(navGrid);

    // Physics world bounds — must match the map, not the canvas size.
    // Without this, setCollideWorldBounds(true) clamps to the RESIZE canvas
    // width and blocks movement before the right/bottom edge of the map.
    this.physics.world.setBounds(0, 0, GRID.width, GRID.height);

    // Player (sprite + keyboard + autopilot).
    const player = this.playerController.init({
      x: GRID.width / 2,
      y: GRID.height - 100,
    });
    this.physics.add.collider(player, this.collision.obstacles);

    // Camera: smooth follow + slight zoom, clamped to the map.
    this.cameras.main.setBounds(0, 0, GRID.width, GRID.height);
    this.cameras.main.setZoom(CAMERA_ZOOM);
    this.cameras.main.startFollow(player, true, 0.12, 0.12);

    // Re-clamp camera + physics bounds whenever the canvas is resized.
    this.scale.on(
      Phaser.Scale.Events.RESIZE,
      () => {
        this.physics.world.setBounds(0, 0, GRID.width, GRID.height);
        this.cameras.main.setBounds(0, 0, GRID.width, GRID.height);
        this.cameras.main.setZoom(CAMERA_ZOOM);
      },
      this
    );

    // NPCs collide with everything.
    this.npcManager.init({ player, obstacles: this.collision.obstacles });

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

    // The Professor — a static NPC at the centre of the map. Always present,
    // interacting with him (E key) spawns his dedicated Claude Code session.
    this.npcManager.spawn({
      id: "professor",
      name: "Le Professeur",
      x: GRID.width / 2,
      y: GRID.height - 250,
      dialogue: "Comment puis-je t'aider ?",
      sprite: "player", // réutilise le sprite du joueur en attendant un sprite dédié
      static: true,
    });

    this.agentSyncer.start();

    if (this.previewGrid) this.drawPreviewGrid();
    if (this.debugMode) this.collision.enableDebug();

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
    const now = this.time.now;
    this.npcManager.updateAll(now, this.dialogue.openNpc);
    this.agentSyncer.tickDespawns(now);
  }

  /** Thin debug overlay drawing the 20×12 logical grid above the map. */
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
