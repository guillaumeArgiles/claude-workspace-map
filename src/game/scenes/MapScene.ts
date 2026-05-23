import Phaser from "phaser";
import { GRID, layerDepth } from "../config/grid";
import { AgentSource } from "../services/agentSource";
import { uiBus, type UiEvents } from "../services/uiBus";
import type { AgentState, SubAgentState } from "../../../shared/agent-types";
import {
  TEACHER_SPRITES,
  STUDENT_SPRITES,
  hashString,
} from "../../../shared/agent-sprites";

const BACKGROUND_KEY = "workspace-background";

interface House {
  id: string;
  building: string;
  /** Centre where the main agent (teacher) wanders around. */
  center: { x: number; y: number };
  /** Point on the path right outside the stairs — used as a waypoint for auto-walk. */
  entrance: { x: number; y: number };
}

interface HouseState {
  house: House;
  cwd: string;
  /** sessionId → slot index used to position the teacher inside the house. */
  teachers: Map<string, number>;
  /** Project name banner rendered above the house. */
  label?: Phaser.GameObjects.Text;
}

const HOUSES: House[] = [
  // `entrance` is the small gap at the bottom of each building (the stairs).
  // Derived from collisions.json: Claude gap x≈266→325, Review x≈667→728,
  // Monitoring x≈1090→1160. y just below the stairs in the path area.
  {
    id: "house_claude",
    building: "CLAUDE",
    center: { x: 290, y: 220 },
    entrance: { x: 295, y: 450 },
  },
  {
    id: "house_review",
    building: "REVIEW",
    center: { x: 720, y: 220 },
    entrance: { x: 697, y: 450 },
  },
  {
    id: "house_monitoring",
    building: "MONITORING",
    center: { x: 1150, y: 220 },
    entrance: { x: 1125, y: 450 },
  },
];


/** Where each successive teacher stands inside the same house (a project). */
const TEACHER_SLOT_OFFSETS: Array<{ dx: number; dy: number }> = [
  { dx: 0, dy: 0 },
  { dx: -90, dy: 30 },
  { dx: 90, dy: 30 },
  { dx: -45, dy: -50 },
  { dx: 45, dy: -50 },
];

/** Offsets around the teacher's home where students wander. */
const STUDENT_OFFSETS: Array<{ dx: number; dy: number }> = [
  { dx: -70, dy: 40 },
  { dx: 70, dy: 40 },
  { dx: -70, dy: -30 },
  { dx: 70, dy: -30 },
  { dx: 0, dy: 60 },
  { dx: 0, dy: -50 },
  { dx: -100, dy: 0 },
  { dx: 100, dy: 0 },
];

function statusDialogue(agent: AgentState | SubAgentState): string {
  // Prefer the rich tool detail (e.g. "npm run dev", "src/MapScene.ts") when present.
  if (agent.currentToolDetail) return agent.currentToolDetail;
  const tool = agent.currentTool ? ` (${agent.currentTool})` : "";
  switch (agent.status) {
    case "planning":
      return "Construit le plan.";
    case "awaiting_approval":
      return "Plan prêt — j'attends ta validation.";
    case "coding":
      return `Modifie les fichiers${tool}.`;
    case "running_tool":
      return `Exécute ${agent.currentTool || "un outil"}.`;
    case "idle":
      return "Au repos.";
    case "done":
      return "Tour terminé.";
    case "blocked":
      return "Bloqué — besoin d'aide.";
    default:
      return "—";
  }
}

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

type AgentStatus =
  | "planning"
  | "awaiting_approval"
  | "coding"
  | "running_tool"
  | "idle"
  | "done"
  | "blocked";

interface NpcDef {
  id: string;
  name: string;
  building?: string;
  /** Free-form role label (e.g. "teacher", "student"). */
  role?: string;
  /** Current agent status. Drives the badge colour and the dialogue line. */
  status?: AgentStatus;
  /** Current tool name (shown in dialogue header next to status). */
  currentTool?: string;
  /** Current tool detail (file path, command, etc.) — populated from AgentState. */
  currentToolDetail?: string;
  /** For students: id of the teacher they're spawned by. */
  parentId?: string;
  x: number;
  y: number;
  /** Fallback dialogue line shown if no live tool detail is available. */
  dialogue: string;
  /** Filename (without extension) under /assets/sprites/. */
  sprite: string;
}

const STATUS_COLOR: Record<AgentStatus, number> = {
  planning: 0x3b82f6,         // blue
  awaiting_approval: 0xeab308, // yellow
  coding: 0x10b981,            // green
  running_tool: 0x06b6d4,      // cyan
  idle: 0x9ca3af,              // gray
  done: 0x22c55e,              // lime
  blocked: 0xef4444,           // red
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  planning: "Planning",
  awaiting_approval: "Awaiting approval",
  coding: "Coding",
  running_tool: "Running tool",
  idle: "Idle",
  done: "Done",
  blocked: "Blocked",
};

interface NpcInstance {
  def: NpcDef;
  sprite: Phaser.Physics.Arcade.Sprite;
  home: { x: number; y: number };
  state: "idle" | "moving";
  target?: { x: number; y: number };
  nextStateAt: number;
  stuckSince?: number;
  lastDir: Direction;
  statusBadge?: Phaser.GameObjects.Graphics;
  /** Live activity bubble shown briefly when the agent starts a new tool. */
  activityBubble?: Phaser.GameObjects.Container;
}

type Direction = "down" | "left" | "right" | "up";

const PLAYER_W = 24;
const PLAYER_H = 32;
const PLAYER_SPEED = 220;
const INTERACTION_RADIUS = 90;

const NPC_SPEED = 55;
const NPC_WANDER_RADIUS = 80;
const NPC_PAUSE_MIN = 1500;
const NPC_PAUSE_MAX = 4000;
const NPC_REACH_DIST = 6;
const NPC_STUCK_TIMEOUT = 400;

interface DrawnRect {
  rect: CollisionRect;
  graphic: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  zone: Phaser.GameObjects.Zone;
}

export class MapScene extends Phaser.Scene {
  private previewGrid = false;
  private debugMode = false;
  private player!: Phaser.Physics.Arcade.Sprite;
  private playerLastDir: Direction = "down";
  /** Optional autopilot: when set, the player walks through these waypoints. */
  private playerAutoWalk?: {
    waypoints: Array<{ x: number; y: number }>;
    targetId: string;
    stuckSince?: number;
    lastDist: number;
  };
  /** IDs of characters whose `right` direction is the flipped `left` sprite. */
  private charNeedsRightFlip = new Set<string>();
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private interactKey!: Phaser.Input.Keyboard.Key;
  private mouseLabel?: Phaser.GameObjects.Text;
  private helpLabel?: Phaser.GameObjects.Text;
  private obstacles!: Phaser.Physics.Arcade.StaticGroup;

  // NPCs + dialogue
  private npcs: NpcInstance[] = [];
  private nearestNpc?: NpcInstance;
  private promptText?: Phaser.GameObjects.Text;
  private dialogueGroup?: Phaser.GameObjects.Container;
  private dialogueOpenFor?: NpcInstance;
  /** Phaser physics group containing every NPC sprite. Lets us add/remove at runtime. */
  private npcGroup!: Phaser.Physics.Arcade.Group;

  // Live agent source state
  private agentSource = new AgentSource();
  /**
   * One house per project (cwd). Several sessions can share a house — they get
   * different slot indexes inside it.
   */
  private housesByCwd = new Map<string, HouseState>();
  private usedHouseIds = new Set<string>();
  private teacherNpcs = new Map<string, NpcInstance>();
  /** sessionId → (subAgentId → NpcInstance) */
  private studentNpcs = new Map<string, Map<string, NpcInstance>>();
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

  /** Final on-screen height (px) for any character with a real sprite. */
  private static readonly TARGET_CHAR_HEIGHT = 64;
  /** Hitbox = fraction of the sprite. Centred horizontally, anchored at feet. */
  private static readonly HITBOX_W_RATIO = 0.7;
  private static readonly HITBOX_H_RATIO = 0.5;
  /** Camera zoom level — 1.0 shows the whole map, >1 zooms in on the player. */
  private static readonly CAMERA_ZOOM = 1.2;
  /**
   * Native texture height (px) after downsample. Smaller than the displayed
   * size on purpose: when Phaser scales it back up with nearest-neighbour,
   * we get visible chunky pixels that match the map's pixel art density.
   */
  private static readonly TARGET_NATIVE_HEIGHT = 32;

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

    // Player
    const playerSpriteKey = this.buildCharacterAnimations("player", "#2b6cb0", "#f6ad55");
    this.player = this.physics.add.sprite(GRID.width / 2, GRID.height - 100, playerSpriteKey);
    this.player.setCollideWorldBounds(true);
    this.player.setDepth(layerDepth.AGENTS);
    this.scaleCharacterIfReal(this.player, playerSpriteKey);
    const pbody = this.player.body as Phaser.Physics.Arcade.Body;
    const pw = this.player.width;
    const ph = this.player.height;
    pbody.setSize(pw * MapScene.HITBOX_W_RATIO, ph * MapScene.HITBOX_H_RATIO);
    pbody.setOffset(
      pw * (1 - MapScene.HITBOX_W_RATIO) / 2,
      ph * (1 - MapScene.HITBOX_H_RATIO)
    );
    this.player.play("player_idle_down");

    this.physics.add.collider(this.player, this.obstacles);

    // Camera: smooth follow + slight zoom, clamped to the map.
    this.cameras.main.setBounds(0, 0, GRID.width, GRID.height);
    this.cameras.main.setZoom(MapScene.CAMERA_ZOOM);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);

    // NPCs are spawned dynamically from the AgentSource. The collider group is
    // empty at first; sprites added later via spawnNpc will collide automatically.
    this.npcGroup = this.physics.add.group();
    this.physics.add.collider(this.player, this.npcGroup);
    this.physics.add.collider(this.npcGroup, this.obstacles);
    this.physics.add.collider(this.npcGroup, this.npcGroup);

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

    this.startAgentSource();

    // UI: hover prompt + dialogue container
    this.promptText = this.add
      .text(0, 0, "", {
        fontSize: "12px",
        color: "#ffffff",
        backgroundColor: "#000000cc",
        padding: { x: 6, y: 3 },
      })
      .setOrigin(0.5, 1)
      .setDepth(layerDepth.OVERLAYS)
      .setVisible(false);

    // Controls
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.interactKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.E);

    if (this.previewGrid) this.drawPreviewGrid();
    if (this.debugMode) {
      this.enableDebugOverlay();
      this.enableDrawingTool();
    }

    // UI bus → highlight an agent when the sidebar fires the intent.
    const onHighlight = (data: UiEvents["highlight_agent"]) => this.highlightAgent(data.id);
    uiBus.on("highlight_agent", onHighlight);

    const cleanup = () => {
      this.agentSource.stop();
      uiBus.off("highlight_agent", onHighlight);
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, cleanup);
    this.events.once(Phaser.Scenes.Events.DESTROY, cleanup);
  }

  /**
   * Pop a quick "found you!" effect on the agent + send the player walking
   * over via the house entrance. Cancels itself on any arrow key.
   */
  private highlightAgent(id: string): void {
    const npc = this.teacherNpcs.get(id) ?? this.findStudentNpc(id);
    if (!npc) return;

    // Visual confirmation: a short hop on the agent.
    const sprite = npc.sprite;
    const restY = sprite.y;
    this.tweens.add({
      targets: sprite,
      y: restY - 14,
      duration: 160,
      ease: Phaser.Math.Easing.Quadratic.Out,
      yoyo: true,
      repeat: 1,
      onComplete: () => sprite.setY(restY),
    });

    // Send the player walking.
    this.startAutoWalk(npc);
  }

  /** Build a list of waypoints from the player to an NPC and trigger the autopilot. */
  private startAutoWalk(npc: NpcInstance): void {
    const house = this.findHouseForNpc(npc);
    const waypoints: Array<{ x: number; y: number }> = [];

    // If the player is below the buildings, route via the entrance first to
    // avoid running into the back walls.
    const alreadyInside = house ? this.player.y < house.center.y + 140 : true;
    if (house && !alreadyInside) {
      waypoints.push({ x: house.entrance.x, y: house.entrance.y });
    }
    // Final waypoint: a couple of pixels below the agent so the player ends up
    // facing them, not standing on top.
    waypoints.push({ x: npc.sprite.x, y: npc.sprite.y + 24 });

    this.playerAutoWalk = {
      waypoints,
      targetId: npc.def.id,
      lastDist: Infinity,
    };
  }

  private findHouseForNpc(npc: NpcInstance): House | undefined {
    const isTeacher = npc.def.role !== "student";
    const sessionId = isTeacher ? npc.def.id : npc.def.parentId;
    if (!sessionId) return undefined;
    for (const state of this.housesByCwd.values()) {
      if (state.teachers.has(sessionId)) return state.house;
    }
    return undefined;
  }

  private findStudentNpc(subId: string): NpcInstance | undefined {
    for (const map of this.studentNpcs.values()) {
      const npc = map.get(subId);
      if (npc) return npc;
    }
    return undefined;
  }

  // ----- Agent source wiring -----

  private startAgentSource(): void {
    this.agentSource.on("open", () => {
      this.statusText?.setText("Connected • 0 agent(s)");
    });
    this.agentSource.on("error", () => {
      this.statusText?.setText("⚠ /api/events disconnected — retrying…");
    });
    this.agentSource.on("snapshot", (agents) => {
      // Reset world and replay each agent through spawn.
      for (const sessionId of Array.from(this.teacherNpcs.keys())) {
        this.removeAgent(sessionId);
      }
      for (const a of agents) this.spawnAgent(a);
      this.refreshStatusText();
    });
    this.agentSource.on("spawn", (a) => {
      this.spawnAgent(a);
      this.refreshStatusText();
    });
    this.agentSource.on("update", (a) => {
      this.updateAgent(a);
    });
    this.agentSource.on("remove", (sessionId) => {
      this.removeAgent(sessionId);
      this.refreshStatusText();
    });
    this.agentSource.start();
  }

  private refreshStatusText(): void {
    const n = this.teacherNpcs.size;
    this.statusText?.setText(`Connected • ${n} agent${n === 1 ? "" : "s"}`);
  }

  /**
   * Place a session in the house representing its project (cwd). If no house is
   * yet assigned to that project, claim the next free one. Returns the house +
   * the slot index where the teacher should stand inside it.
   */
  private assignToHouse(cwd: string, sessionId: string, projectName: string): { house: House; slot: number } | null {
    let state = this.housesByCwd.get(cwd);
    if (!state) {
      const free = HOUSES.find((h) => !this.usedHouseIds.has(h.id));
      if (!free) return null;
      state = { house: free, cwd, teachers: new Map() };
      state.label = this.makeHouseLabel(free, projectName);
      this.housesByCwd.set(cwd, state);
      this.usedHouseIds.add(free.id);
    }
    let slot = state.teachers.get(sessionId);
    if (slot === undefined) {
      const taken = new Set(state.teachers.values());
      slot = 0;
      while (taken.has(slot)) slot++;
      state.teachers.set(sessionId, slot);
    }
    return { house: state.house, slot };
  }

  private releaseFromHouse(cwd: string, sessionId: string): void {
    const state = this.housesByCwd.get(cwd);
    if (!state) return;
    state.teachers.delete(sessionId);
    if (state.teachers.size === 0) {
      state.label?.destroy();
      this.housesByCwd.delete(cwd);
      this.usedHouseIds.delete(state.house.id);
    }
  }

  private makeHouseLabel(house: House, projectName: string): Phaser.GameObjects.Text {
    // Sits in world space just above the building, so the camera reveals it as
    // you approach the house.
    const label = this.add
      .text(house.center.x, 56, projectName, {
        fontSize: "14px",
        fontStyle: "bold",
        color: "#fffaf0",
        backgroundColor: "#1f2937dd",
        padding: { x: 8, y: 4 },
        align: "center",
      })
      .setOrigin(0.5, 0.5)
      .setDepth(layerDepth.UI - 1);
    return label;
  }

  private teacherPosition(house: House, slot: number): { x: number; y: number } {
    const offset = TEACHER_SLOT_OFFSETS[slot % TEACHER_SLOT_OFFSETS.length];
    return { x: house.center.x + offset.dx, y: house.center.y + offset.dy };
  }

  private spawnAgent(agent: AgentState): void {
    if (this.teacherNpcs.has(agent.sessionId)) {
      this.updateAgent(agent);
      return;
    }
    // No house can be picked without a known project — wait for the next update
    // that brings the `cwd` field along.
    if (!agent.cwd) return;
    const placement = this.assignToHouse(agent.cwd, agent.sessionId, agent.projectName);
    if (!placement) return; // all houses are busy with other projects

    const def = this.agentToNpcDef(agent, placement.house, placement.slot);
    const npc = this.spawnNpc(def);
    this.teacherNpcs.set(agent.sessionId, npc);

    const studentMap = new Map<string, NpcInstance>();
    this.studentNpcs.set(agent.sessionId, studentMap);
    for (const sub of agent.subAgents) {
      if (sub.finished) continue;
      const studentNpc = this.spawnStudent(agent, sub, npc);
      if (studentNpc) studentMap.set(sub.id, studentNpc);
    }
  }

  private updateAgent(agent: AgentState): void {
    const npc = this.teacherNpcs.get(agent.sessionId);
    if (!npc) {
      // Wasn't spawned yet — maybe cwd just arrived or a house freed up.
      this.spawnAgent(agent);
      return;
    }

    const prevTool = npc.def.currentTool;
    const prevDetail = npc.def.currentToolDetail;
    npc.def.status = agent.status;
    npc.def.name = agent.projectName;
    npc.def.currentTool = agent.currentTool;
    npc.def.currentToolDetail = agent.currentToolDetail;
    npc.def.dialogue = statusDialogue(agent);
    this.refreshStatusBadge(npc);
    if (this.dialogueOpenFor === npc) this.refreshDialogue(npc);
    if (prevTool !== agent.currentTool || prevDetail !== agent.currentToolDetail) {
      this.showActivityBubble(npc);
    }

    const studentMap = this.studentNpcs.get(agent.sessionId) ?? new Map();
    this.studentNpcs.set(agent.sessionId, studentMap);
    const incoming = new Set<string>();
    for (const sub of agent.subAgents) {
      if (sub.finished) continue;
      incoming.add(sub.id);
      const existing = studentMap.get(sub.id);
      if (existing) {
        const subPrevTool = existing.def.currentTool;
        const subPrevDetail = existing.def.currentToolDetail;
        existing.def.status = sub.status;
        existing.def.currentTool = sub.currentTool;
        existing.def.currentToolDetail = sub.currentToolDetail;
        existing.def.dialogue = statusDialogue(sub);
        this.refreshStatusBadge(existing);
        if (this.dialogueOpenFor === existing) this.refreshDialogue(existing);
        if (subPrevTool !== sub.currentTool || subPrevDetail !== sub.currentToolDetail) {
          this.showActivityBubble(existing);
        }
      } else {
        const studentNpc = this.spawnStudent(agent, sub, npc);
        if (studentNpc) studentMap.set(sub.id, studentNpc);
      }
    }
    for (const [subId, studentNpc] of studentMap) {
      if (!incoming.has(subId)) {
        this.destroyNpc(studentNpc);
        studentMap.delete(subId);
      }
    }
  }

  private removeAgent(sessionId: string): void {
    const npc = this.teacherNpcs.get(sessionId);
    if (npc) {
      this.destroyNpc(npc);
      this.teacherNpcs.delete(sessionId);
      // Find which cwd this session was housed in and release its slot.
      for (const [cwd, state] of this.housesByCwd) {
        if (state.teachers.has(sessionId)) {
          this.releaseFromHouse(cwd, sessionId);
          break;
        }
      }
    }
    const students = this.studentNpcs.get(sessionId);
    if (students) {
      for (const s of students.values()) this.destroyNpc(s);
      this.studentNpcs.delete(sessionId);
    }
    if (this.dialogueOpenFor && this.dialogueOpenFor.def.id === sessionId) {
      this.closeDialogue();
    }
  }

  private agentToNpcDef(agent: AgentState, house: House, slot: number): NpcDef {
    const pos = this.teacherPosition(house, slot);
    const spriteIdx = hashString(agent.sessionId) % TEACHER_SPRITES.length;
    return {
      id: agent.sessionId,
      name: agent.projectName,
      building: house.building,
      role: "teacher",
      status: agent.status,
      currentTool: agent.currentTool,
      currentToolDetail: agent.currentToolDetail,
      x: pos.x,
      y: pos.y,
      sprite: TEACHER_SPRITES[spriteIdx],
      dialogue: statusDialogue(agent),
    };
  }

  private spawnStudent(
    agent: AgentState,
    sub: SubAgentState,
    teacherNpc: NpcInstance
  ): NpcInstance | null {
    const offsetIdx = hashString(sub.id) % STUDENT_OFFSETS.length;
    const offset = STUDENT_OFFSETS[offsetIdx];
    const spriteIdx = hashString(sub.id) % STUDENT_SPRITES.length;
    const def: NpcDef = {
      id: sub.id,
      name: sub.description ? sub.description : `${agent.projectName} · sub`,
      building: teacherNpc.def.building,
      role: "student",
      parentId: agent.sessionId,
      status: sub.status,
      currentTool: sub.currentTool,
      currentToolDetail: sub.currentToolDetail,
      x: teacherNpc.home.x + offset.dx,
      y: teacherNpc.home.y + offset.dy,
      sprite: STUDENT_SPRITES[spriteIdx],
      dialogue: statusDialogue(sub),
    };
    return this.spawnNpc(def);
  }

  private destroyNpc(npc: NpcInstance): void {
    npc.statusBadge?.destroy();
    npc.activityBubble?.destroy();
    npc.sprite.destroy();
    const idx = this.npcs.indexOf(npc);
    if (idx >= 0) this.npcs.splice(idx, 1);
    if (this.nearestNpc === npc) this.nearestNpc = undefined;
  }

  private refreshStatusBadge(npc: NpcInstance): void {
    npc.statusBadge?.destroy();
    npc.statusBadge = this.makeStatusBadge(npc.def.status ?? "idle");
  }

  /**
   * Show a transient "what they're doing now" bubble above the agent's head.
   * Replaces any previous bubble for the same agent.
   */
  private showActivityBubble(npc: NpcInstance): void {
    const tool = npc.def.currentTool;
    if (!tool) {
      npc.activityBubble?.destroy();
      npc.activityBubble = undefined;
      return;
    }
    const detail = npc.def.currentToolDetail;
    const text = detail ? `${tool} · ${detail}` : tool;

    npc.activityBubble?.destroy();

    const padX = 6;
    const padY = 3;
    const label = this.add.text(0, 0, text, {
      fontSize: "10px",
      color: "#1a202c",
      wordWrap: { width: 220 },
    });
    const w = Math.min(label.width, 220) + padX * 2;
    const h = label.height + padY * 2 + 4;
    const bg = this.add.graphics();
    bg.fillStyle(0xffffff, 0.95);
    bg.lineStyle(1, 0x111111, 0.9);
    bg.fillRoundedRect(0, 0, w, h, 5);
    bg.strokeRoundedRect(0, 0, w, h, 5);
    bg.fillTriangle(w / 2 - 4, h, w / 2 + 4, h, w / 2, h + 5);
    bg.lineBetween(w / 2 - 4, h, w / 2, h + 5);
    bg.lineBetween(w / 2, h + 5, w / 2 + 4, h);
    label.setPosition(padX, padY);

    const container = this.add.container(0, 0, [bg, label]);
    container.setSize(w, h);
    container.setDepth(layerDepth.OVERLAYS);
    npc.activityBubble = container;
    this.positionActivityBubble(npc);

    // Auto-fade after 4s.
    this.tweens.add({
      targets: container,
      alpha: 0,
      delay: 3500,
      duration: 500,
      onComplete: () => {
        if (npc.activityBubble === container) npc.activityBubble = undefined;
        container.destroy();
      },
    });
  }

  private positionActivityBubble(npc: NpcInstance): void {
    if (!npc.activityBubble) return;
    const sprite = npc.sprite;
    const w = npc.activityBubble.width;
    const h = npc.activityBubble.height;
    npc.activityBubble.setPosition(
      sprite.x - w / 2,
      sprite.y - sprite.displayHeight * 0.5 - h - 14
    );
    npc.activityBubble.setDepth(sprite.depth + 2);
  }

  update(): void {
    // Movement: keyboard wins over autopilot. Pressing any arrow cancels
    // the auto-walk so the user always stays in control.
    const speed = PLAYER_SPEED;
    let vx = 0;
    let vy = 0;
    const anyArrow =
      this.cursors.left.isDown ||
      this.cursors.right.isDown ||
      this.cursors.up.isDown ||
      this.cursors.down.isDown;
    if (anyArrow && this.playerAutoWalk) this.playerAutoWalk = undefined;

    if (this.playerAutoWalk) {
      const walk = this.playerAutoWalk;
      const wp = walk.waypoints[0];
      if (!wp) {
        this.playerAutoWalk = undefined;
      } else {
        const dx = wp.x - this.player.x;
        const dy = wp.y - this.player.y;
        const dist = Math.hypot(dx, dy);

        if (dist < 14) {
          walk.waypoints.shift();
          if (walk.waypoints.length === 0) {
            // Arrived at the agent: stop and open the dialogue.
            const targetId = walk.targetId;
            this.playerAutoWalk = undefined;
            const target =
              this.teacherNpcs.get(targetId) ?? this.findStudentNpc(targetId);
            if (target) {
              this.nearestNpc = target;
              this.openDialogue(target);
            }
          }
        } else {
          const inv = 1 / dist;
          vx = dx * inv * speed;
          vy = dy * inv * speed;

          // Stuck detection — if we stop making progress against a wall for
          // ~1.2 s, give up and hand control back to the user.
          const body = this.player.body as Phaser.Physics.Arcade.Body;
          const blocked =
            body.blocked.left || body.blocked.right || body.blocked.up || body.blocked.down;
          if (blocked && Math.abs(walk.lastDist - dist) < 1) {
            walk.stuckSince ??= this.time.now;
            if (this.time.now - walk.stuckSince > 1200) {
              this.playerAutoWalk = undefined;
              vx = 0;
              vy = 0;
            }
          } else {
            walk.stuckSince = undefined;
          }
          walk.lastDist = dist;
        }
      }
    } else {
      if (this.cursors.left.isDown) vx = -speed;
      else if (this.cursors.right.isDown) vx = speed;
      if (this.cursors.up.isDown) vy = -speed;
      else if (this.cursors.down.isDown) vy = speed;
    }

    if (vx !== 0 && vy !== 0) {
      const inv = 1 / Math.SQRT2;
      vx *= inv;
      vy *= inv;
    }

    this.player.setVelocity(vx, vy);
    this.player.setDepth(layerDepth.AGENTS + Math.round(this.player.y));

    // Player animation: 4-direction (down/left/right/up).
    const moving = vx !== 0 || vy !== 0;
    if (moving) {
      if (Math.abs(vx) >= Math.abs(vy) && vx !== 0) {
        this.playerLastDir = vx < 0 ? "left" : "right";
      } else if (vy !== 0) {
        this.playerLastDir = vy < 0 ? "up" : "down";
      }
    }
    this.player.play(`player_${moving ? "walk" : "idle"}_${this.playerLastDir}`, true);
    this.player.setFlipX(
      this.charNeedsRightFlip.has("player") && this.playerLastDir === "right"
    );

    // NPC AI + y-sort + status badge follow + activity bubble follow
    const now = this.time.now;
    for (const npc of this.npcs) {
      this.updateNpc(npc, now);
      npc.sprite.setDepth(layerDepth.AGENTS + Math.round(npc.sprite.y));
      this.updateStatusBadge(npc);
      this.positionActivityBubble(npc);
    }

    // Interaction prompt
    this.updateNearestNpc();
    this.updateDialogueInput();
  }

  // ----- NPCs -----

  private spawnNpc(def: NpcDef): NpcInstance {
    const spriteKey = this.buildCharacterAnimations(
      def.id,
      "#6b7280",
      "#fcd9b6",
      def.sprite
    );
    const sprite = this.physics.add.sprite(def.x, def.y, spriteKey);
    sprite.setCollideWorldBounds(true);
    this.scaleCharacterIfReal(sprite, spriteKey);
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    body.pushable = false;
    body.setSize(sprite.width * MapScene.HITBOX_W_RATIO, sprite.height * MapScene.HITBOX_H_RATIO);
    body.setOffset(
      sprite.width * (1 - MapScene.HITBOX_W_RATIO) / 2,
      sprite.height * (1 - MapScene.HITBOX_H_RATIO)
    );
    sprite.setDepth(layerDepth.AGENTS + Math.round(def.y));
    sprite.play(`${def.id}_idle_down`);

    if (this.npcGroup) this.npcGroup.add(sprite);

    const instance: NpcInstance = {
      def,
      sprite,
      home: { x: def.x, y: def.y },
      state: "idle",
      nextStateAt: this.time.now + Phaser.Math.Between(NPC_PAUSE_MIN, NPC_PAUSE_MAX),
      lastDir: "down",
    };
    instance.statusBadge = this.makeStatusBadge(def.status ?? "idle");
    this.npcs.push(instance);
    return instance;
  }

  private makeStatusBadge(status: AgentStatus): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    g.fillStyle(STATUS_COLOR[status], 1);
    g.fillCircle(0, 0, 5);
    g.lineStyle(1, 0x111111, 0.9);
    g.strokeCircle(0, 0, 5);
    g.setDepth(layerDepth.OVERLAYS);
    return g;
  }

  private updateStatusBadge(npc: NpcInstance): void {
    if (!npc.statusBadge) return;
    const sprite = npc.sprite;
    const topY = sprite.y - sprite.displayHeight * 0.5 - 6;
    npc.statusBadge.setPosition(sprite.x, topY);
    npc.statusBadge.setDepth(sprite.depth + 1);
  }

  private updateNpc(npc: NpcInstance, now: number): void {
    const id = npc.def.id;
    const playIdle = () => {
      npc.sprite.play(`${id}_idle_${npc.lastDir}`, true);
      npc.sprite.setFlipX(this.charNeedsRightFlip.has(id) && npc.lastDir === "right");
    };

    if (this.dialogueOpenFor === npc) {
      npc.sprite.setVelocity(0, 0);
      playIdle();
      return;
    }

    if (npc.state === "idle") {
      if (now >= npc.nextStateAt) {
        npc.target = this.pickWanderTarget(npc);
        npc.state = "moving";
        npc.stuckSince = undefined;
      } else {
        npc.sprite.setVelocity(0, 0);
        playIdle();
      }
      return;
    }

    if (!npc.target) {
      npc.state = "idle";
      npc.nextStateAt = now + Phaser.Math.Between(NPC_PAUSE_MIN, NPC_PAUSE_MAX);
      return;
    }

    const dx = npc.target.x - npc.sprite.x;
    const dy = npc.target.y - npc.sprite.y;
    const dist = Math.hypot(dx, dy);

    if (dist < NPC_REACH_DIST) {
      npc.sprite.setVelocity(0, 0);
      npc.state = "idle";
      npc.target = undefined;
      npc.nextStateAt = now + Phaser.Math.Between(NPC_PAUSE_MIN, NPC_PAUSE_MAX);
      playIdle();
      return;
    }

    const inv = 1 / dist;
    const vx = dx * inv * NPC_SPEED;
    const vy = dy * inv * NPC_SPEED;
    npc.sprite.setVelocity(vx, vy);

    if (Math.abs(vx) >= Math.abs(vy)) {
      npc.lastDir = vx < 0 ? "left" : "right";
    } else {
      npc.lastDir = vy < 0 ? "up" : "down";
    }
    npc.sprite.play(`${id}_walk_${npc.lastDir}`, true);
    npc.sprite.setFlipX(this.charNeedsRightFlip.has(id) && npc.lastDir === "right");

    const body = npc.sprite.body as Phaser.Physics.Arcade.Body;
    const blocked =
      body.blocked.left || body.blocked.right || body.blocked.up || body.blocked.down;
    if (blocked) {
      npc.stuckSince ??= now;
      if (now - npc.stuckSince > NPC_STUCK_TIMEOUT) {
        npc.sprite.setVelocity(0, 0);
        npc.state = "idle";
        npc.target = undefined;
        npc.nextStateAt = now + Phaser.Math.Between(NPC_PAUSE_MIN / 2, NPC_PAUSE_MAX / 2);
        playIdle();
      }
    } else {
      npc.stuckSince = undefined;
    }
  }

  private pickWanderTarget(npc: NpcInstance): { x: number; y: number } {
    const angle = Math.random() * Math.PI * 2;
    const radius = Phaser.Math.Between(20, NPC_WANDER_RADIUS);
    return {
      x: npc.home.x + Math.cos(angle) * radius,
      y: npc.home.y + Math.sin(angle) * radius,
    };
  }

  private updateNearestNpc(): void {
    let best: NpcInstance | undefined;
    let bestDist = INTERACTION_RADIUS;
    for (const npc of this.npcs) {
      const dx = npc.sprite.x - this.player.x;
      const dy = npc.sprite.y - this.player.y;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        best = npc;
      }
    }

    this.nearestNpc = best;
    if (!this.promptText) return;

    if (best && this.dialogueOpenFor !== best) {
      this.promptText.setText(`[E] parler à ${best.def.name}`);
      this.promptText.setPosition(best.sprite.x, best.sprite.y - PLAYER_H);
      this.promptText.setDepth(layerDepth.OVERLAYS + Math.round(best.sprite.y));
      this.promptText.setVisible(true);
    } else {
      this.promptText.setVisible(false);
    }

    // Close any open dialogue when we walk out of range.
    if (this.dialogueOpenFor && this.dialogueOpenFor !== best) {
      this.closeDialogue();
    }
  }

  private updateDialogueInput(): void {
    if (Phaser.Input.Keyboard.JustDown(this.interactKey)) {
      if (this.dialogueOpenFor) {
        this.closeDialogue();
      } else if (this.nearestNpc) {
        this.openDialogue(this.nearestNpc);
      }
    }
  }

  private openDialogue(npc: NpcInstance): void {
    this.closeDialogue();

    const padding = 10;
    const maxWidth = 340;
    const status = npc.def.status;
    const statusLabel = status ? STATUS_LABEL[status] : "";
    // Teachers: just "Status · Tool" (project name is already on the house
    // banner above). Students: their description if any, status as fallback.
    let heading: string;
    if (npc.def.role === "student") {
      heading = npc.def.name && !npc.def.name.includes(" · sub")
        ? npc.def.name
        : [statusLabel, npc.def.currentTool].filter(Boolean).join("  ·  ");
    } else {
      heading = [statusLabel, npc.def.currentTool].filter(Boolean).join("  ·  ") || npc.def.name;
    }
    const line = npc.def.dialogue;

    const nameText = this.add.text(0, 0, heading, {
      fontSize: "13px",
      fontStyle: "bold",
      color: "#1a202c",
    });
    const bodyText = this.add.text(0, 18, line, {
      fontSize: "12px",
      color: "#1a202c",
      wordWrap: { width: maxWidth },
    });

    const w = Math.max(nameText.width, bodyText.width) + padding * 2;
    const h = nameText.height + bodyText.height + padding * 2 + 4;

    const bg = this.add.graphics();
    bg.fillStyle(0xffffff, 1);
    bg.lineStyle(2, 0x1a202c, 1);
    bg.fillRoundedRect(0, 0, w, h, 8);
    bg.strokeRoundedRect(0, 0, w, h, 8);
    // tail
    const tailX = w / 2;
    bg.fillTriangle(tailX - 8, h, tailX + 8, h, tailX, h + 10);
    bg.lineBetween(tailX - 8, h, tailX, h + 10);
    bg.lineBetween(tailX, h + 10, tailX + 8, h);

    nameText.setPosition(padding, padding);
    bodyText.setPosition(padding, padding + nameText.height + 4);

    const container = this.add.container(0, 0, [bg, nameText, bodyText]);
    container.setSize(w, h);
    container.setDepth(layerDepth.OVERLAYS + 10000);
    // Anchor: bottom-center of bubble above the NPC.
    const bx = Phaser.Math.Clamp(npc.sprite.x - w / 2, 8, GRID.width - w - 8);
    const by = npc.sprite.y - PLAYER_H - h - 12;
    container.setPosition(bx, Math.max(8, by));

    this.dialogueGroup = container;
    this.dialogueOpenFor = npc;
    if (this.promptText) this.promptText.setVisible(false);
  }

  private closeDialogue(): void {
    this.dialogueGroup?.destroy();
    this.dialogueGroup = undefined;
    this.dialogueOpenFor = undefined;
  }

  private refreshDialogue(npc: NpcInstance): void {
    // Cheap update: re-open the dialogue with the latest dialogue line.
    if (this.dialogueOpenFor !== npc) return;
    this.openDialogue(npc);
  }

  private formatRole(role?: string): string {
    if (!role) return "";
    // Title-case the JSON role ("teacher" → "Teacher").
    return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
  }

  /**
   * Build walk/idle animations for a character. Uses the real sprite sheet at
   * /assets/sprites/<id>.png if it loaded, otherwise generates a programmatic
   * 2-frame placeholder with a simple leg-swap walk cycle.
   * Returns the texture key the sprite should start with.
   */
  private buildCharacterAnimations(
    id: string,
    bodyHex: string,
    headHex: string,
    spriteSource?: string
  ): string {
    const source = spriteSource ?? id;
    const imageKey = `${source}_image`;

    if (this.textures.exists(imageKey)) {
      const img = this.textures.get(imageKey).getSourceImage() as
        | HTMLImageElement
        | HTMLCanvasElement;
      const ratio = img.width / img.height;

      // RPG Maker format: 3 cols × 4 rows. Rows = down/left/right/up.
      // Cols = step A / idle / step B. Walk loop = 1 → 0 → 1 → 2.
      if (Math.abs(ratio - 3 / 4) < 0.05 && img.width % 3 === 0 && img.height % 4 === 0) {
        const sheetKey = `${source}_sheet`;
        if (!this.textures.exists(sheetKey)) {
          this.textures.addSpriteSheet(sheetKey, img as HTMLImageElement, {
            frameWidth: img.width / 3,
            frameHeight: img.height / 4,
          });
        }
        const rowFor: Record<Direction, number> = { down: 0, left: 1, right: 2, up: 3 };
        for (const dir of ["down", "left", "right", "up"] as Direction[]) {
          const r = rowFor[dir];
          const base = r * 3;
          const walkKey = `${id}_walk_${dir}`;
          const idleKey = `${id}_idle_${dir}`;
          if (!this.anims.exists(walkKey)) {
            this.anims.create({
              key: walkKey,
              frames: [
                { key: sheetKey, frame: base + 1 },
                { key: sheetKey, frame: base + 0 },
                { key: sheetKey, frame: base + 1 },
                { key: sheetKey, frame: base + 2 },
              ],
              frameRate: 6,
              repeat: -1,
            });
          }
          if (!this.anims.exists(idleKey)) {
            this.anims.create({
              key: idleKey,
              frames: [{ key: sheetKey, frame: base + 1 }],
              frameRate: 1,
            });
          }
        }
        return sheetKey;
      }

      // Legacy single-row 3-frame sheet (front view only): flip for right.
      this.ensureCleanedTexture(imageKey);
      const cleanedImg = this.textures.get(imageKey).getSourceImage() as HTMLImageElement;
      const sheetKey = `${source}_sheet`;
      if (!this.textures.exists(sheetKey)) {
        this.textures.addSpriteSheet(sheetKey, cleanedImg, {
          frameWidth: Math.floor(cleanedImg.width / 3),
          frameHeight: cleanedImg.height,
        });
      }
      // Same frames for all directions; flip horizontally for right.
      for (const dir of ["down", "left", "right", "up"] as Direction[]) {
        const walkKey = `${id}_walk_${dir}`;
        const idleKey = `${id}_idle_${dir}`;
        if (!this.anims.exists(walkKey)) {
          this.anims.create({
            key: walkKey,
            frames: this.anims.generateFrameNumbers(sheetKey, { start: 0, end: 2 }),
            frameRate: 6,
            repeat: -1,
          });
        }
        if (!this.anims.exists(idleKey)) {
          this.anims.create({
            key: idleKey,
            frames: [{ key: sheetKey, frame: 0 }],
            frameRate: 1,
          });
        }
      }
      this.charNeedsRightFlip.add(id);
      return sheetKey;
    }

    // Programmatic placeholder fallback.
    const body = Phaser.Display.Color.HexStringToColor(bodyHex).color;
    const head = Phaser.Display.Color.HexStringToColor(headHex).color;
    const f0 = `${id}_f0`;
    const f1 = `${id}_f1`;
    if (!this.textures.exists(f0)) this.drawPlaceholderFrame(f0, body, head, 0);
    if (!this.textures.exists(f1)) this.drawPlaceholderFrame(f1, body, head, 1);

    if (!this.anims.exists(`${id}_walk`)) {
      this.anims.create({
        key: `${id}_walk`,
        frames: [{ key: f0 }, { key: f1 }],
        frameRate: 6,
        repeat: -1,
      });
    }
    if (!this.anims.exists(`${id}_idle`)) {
      this.anims.create({
        key: `${id}_idle`,
        frames: [{ key: f0 }],
        frameRate: 1,
      });
    }
    return f0;
  }

  /** Scale a sprite to TARGET_CHAR_HEIGHT only if it's backed by a real spritesheet. */
  private scaleCharacterIfReal(
    sprite: Phaser.Physics.Arcade.Sprite,
    initialKey: string
  ): void {
    if (initialKey.endsWith("_f0")) return; // programmatic placeholder, leave native size
    const naturalH = sprite.height;
    if (naturalH <= 0) return;
    const scale = MapScene.TARGET_CHAR_HEIGHT / naturalH;
    sprite.setScale(scale);
  }

  /**
   * Replace `imageKey` with a transparency-cleaned version. Two cleanup passes:
   *   1. Chroma-key magenta (#FF00FF ± tolerance) — for AI sprites that use solid color BG.
   *   2. Flood-fill from corners — for AI sprites that bake the "transparency
   *      checkerboard" into actual pixels.
   * Both passes are safe no-ops when the source is genuinely transparent.
   */
  private ensureCleanedTexture(imageKey: string): void {
    if (!this.textures.exists(imageKey)) return;
    const tex = this.textures.get(imageKey);
    if ((tex as unknown as { __cleaned?: boolean }).__cleaned) return;

    const source = tex.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    const w = source.width;
    const h = source.height;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(source, 0, 0);

    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    // Pass 1: chroma-key magenta (R high, G low, B high).
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] > 200) {
        data[i + 3] = 0;
      }
    }

    // Pass 2: checkerboard flood-fill (kept for legacy AI sprites).
    if (data[3] > 0) {
      // Only run if the top-left pixel isn't already transparent (i.e. magenta key didn't catch it).
      const c1: [number, number, number] = [data[0], data[1], data[2]];
      let c2: [number, number, number] = c1;
      for (let x = 1; x < Math.min(w, 64); x++) {
        const i = x * 4;
        if (Math.abs(data[i] - c1[0]) > 12) {
          c2 = [data[i], data[i + 1], data[i + 2]];
          break;
        }
      }
      const TOL = 10;
      const isBg = (r: number, g: number, b: number) =>
        (Math.abs(r - c1[0]) <= TOL && Math.abs(g - c1[1]) <= TOL && Math.abs(b - c1[2]) <= TOL) ||
        (Math.abs(r - c2[0]) <= TOL && Math.abs(g - c2[1]) <= TOL && Math.abs(b - c2[2]) <= TOL);
      const visited = new Uint8Array(w * h);
      const stack: number[] = [];
      const tryPush = (x: number, y: number) => {
        if (x < 0 || x >= w || y < 0 || y >= h) return;
        const idx = y * w + x;
        if (visited[idx]) return;
        visited[idx] = 1;
        const p = idx * 4;
        if (data[p + 3] > 0 && isBg(data[p], data[p + 1], data[p + 2])) {
          data[p + 3] = 0;
          stack.push(idx);
        }
      };
      tryPush(0, 0);
      tryPush(w - 1, 0);
      tryPush(0, h - 1);
      tryPush(w - 1, h - 1);
      while (stack.length) {
        const idx = stack.pop()!;
        const x = idx % w;
        const y = (idx - x) / w;
        tryPush(x - 1, y);
        tryPush(x + 1, y);
        tryPush(x, y - 1);
        tryPush(x, y + 1);
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // Downsample to TARGET_NATIVE_HEIGHT so the texture's native pixel density
    // matches the map's chunky pixel art. The chroma-key already made the BG
    // transparent, so bilinear downsampling antialiases the character edges
    // against alpha=0 instead of leaving magenta fringe.
    let finalCanvas: HTMLCanvasElement = canvas;
    if (h > MapScene.TARGET_NATIVE_HEIGHT * 1.5) {
      const scale = MapScene.TARGET_NATIVE_HEIGHT / h;
      const small = document.createElement("canvas");
      small.width = Math.max(1, Math.round(w * scale));
      small.height = Math.max(1, Math.round(h * scale));
      const sctx = small.getContext("2d")!;
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = "high";
      sctx.drawImage(canvas, 0, 0, small.width, small.height);
      finalCanvas = small;
    }

    this.textures.remove(imageKey);
    this.textures.addCanvas(imageKey, finalCanvas);
    (this.textures.get(imageKey) as unknown as { __cleaned?: boolean }).__cleaned = true;
  }

  private drawPlaceholderFrame(
    key: string,
    body: number,
    head: number,
    frame: 0 | 1
  ): void {
    const W = PLAYER_W;
    const H = PLAYER_H;
    const PANTS = 0x1a202c;
    const g = this.add.graphics();
    // Torso
    g.fillStyle(body, 1);
    g.fillRect(2, 14, W - 4, H - 16 - 4);
    // Head
    g.fillStyle(head, 1);
    g.fillRect(6, 2, W - 12, 12);
    // Legs: frame 0 standing, frame 1 spread (visible walk step)
    g.fillStyle(PANTS, 1);
    if (frame === 0) {
      g.fillRect(7, 26, 4, 6);
      g.fillRect(13, 26, 4, 6);
    } else {
      g.fillRect(5, 25, 4, 7);
      g.fillRect(15, 25, 4, 7);
    }
    g.lineStyle(1, 0x111111, 1);
    g.strokeRect(2, 14, W - 4, H - 16 - 4);
    g.strokeRect(6, 2, W - 12, 12);
    g.generateTexture(key, W, H);
    g.destroy();
  }

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
