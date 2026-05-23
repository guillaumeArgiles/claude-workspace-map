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
import { STATUS_LABEL } from "../../../shared/agent-ui";
import {
  HOUSES,
  STUDENT_OFFSETS,
  statusDialogue,
  teacherPosition,
  type House,
  type HouseState,
} from "../world/houseLayout";
import {
  PLAYER_H,
  PLAYER_SPEED,
  INTERACTION_RADIUS,
  HITBOX_W_RATIO,
  HITBOX_H_RATIO,
  CAMERA_ZOOM,
} from "../world/gameplayConstants";
import type { Direction, NpcDef, NpcInstance } from "../agents/types";
import { NpcManager } from "../agents/NpcManager";

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
  private player!: Phaser.Physics.Arcade.Sprite;
  private playerLastDir: Direction = "down";
  /** Optional autopilot: when set, the player walks through these waypoints. */
  private playerAutoWalk?: {
    waypoints: Array<{ x: number; y: number }>;
    targetId: string;
    stuckSince?: number;
    lastDist: number;
  };
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private interactKey!: Phaser.Input.Keyboard.Key;
  private mouseLabel?: Phaser.GameObjects.Text;
  private helpLabel?: Phaser.GameObjects.Text;
  private obstacles!: Phaser.Physics.Arcade.StaticGroup;

  // NPCs + dialogue
  private npcManager = new NpcManager(this);
  private nearestNpc?: NpcInstance;
  private promptText?: Phaser.GameObjects.Text;
  private dialogueGroup?: Phaser.GameObjects.Container;
  private dialogueOpenFor?: NpcInstance;

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
    const playerSpriteKey = this.npcManager.buildCharacterAnimations(
      "player",
      "#2b6cb0",
      "#f6ad55"
    );
    this.player = this.physics.add.sprite(GRID.width / 2, GRID.height - 100, playerSpriteKey);
    this.player.setCollideWorldBounds(true);
    this.player.setDepth(layerDepth.AGENTS);
    this.npcManager.scaleCharacterIfReal(this.player, playerSpriteKey);
    const pbody = this.player.body as Phaser.Physics.Arcade.Body;
    const pw = this.player.width;
    const ph = this.player.height;
    pbody.setSize(pw * HITBOX_W_RATIO, ph * HITBOX_H_RATIO);
    pbody.setOffset(
      pw * (1 - HITBOX_W_RATIO) / 2,
      ph * (1 - HITBOX_H_RATIO)
    );
    this.player.play("player_idle_down");

    this.physics.add.collider(this.player, this.obstacles);

    // Camera: smooth follow + slight zoom, clamped to the map.
    this.cameras.main.setBounds(0, 0, GRID.width, GRID.height);
    this.cameras.main.setZoom(CAMERA_ZOOM);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);

    // NPCs: NpcManager owns the physics group and the colliders.
    this.npcManager.init({ player: this.player, obstacles: this.obstacles });

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
    const npc = this.npcManager.spawn(def);
    this.teacherNpcs.set(agent.sessionId, npc);

    const studentMap = new Map<string, NpcInstance>();
    this.studentNpcs.set(agent.sessionId, studentMap);
    for (const sub of agent.subAgents) {
      if (sub.finished) continue;
      const studentNpc = this.spawnStudent(agent, sub, npc);
      if (studentNpc) {
        studentMap.set(sub.id, studentNpc);
        this.npcManager.fadeIn(studentNpc);
      }
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
    this.npcManager.refreshStatusBadge(npc);
    if (this.dialogueOpenFor === npc) this.refreshDialogue(npc);
    if (prevTool !== agent.currentTool || prevDetail !== agent.currentToolDetail) {
      this.npcManager.showActivityBubble(npc);
    }

    const studentMap = this.studentNpcs.get(agent.sessionId) ?? new Map();
    this.studentNpcs.set(agent.sessionId, studentMap);
    const incoming = new Set<string>();
    for (const sub of agent.subAgents) {
      if (sub.finished) continue;
      incoming.add(sub.id);
      const existing = studentMap.get(sub.id);
      if (existing) {
        // Re-activated: cancel any pending despawn from a previous "done" linger.
        existing.despawnAt = undefined;
        const subPrevTool = existing.def.currentTool;
        const subPrevDetail = existing.def.currentToolDetail;
        existing.def.status = sub.status;
        existing.def.currentTool = sub.currentTool;
        existing.def.currentToolDetail = sub.currentToolDetail;
        existing.def.dialogue = statusDialogue(sub);
        this.npcManager.refreshStatusBadge(existing);
        if (this.dialogueOpenFor === existing) this.refreshDialogue(existing);
        if (subPrevTool !== sub.currentTool || subPrevDetail !== sub.currentToolDetail) {
          this.npcManager.showActivityBubble(existing);
        }
      } else {
        const studentNpc = this.spawnStudent(agent, sub, npc);
        if (studentNpc) {
          studentMap.set(sub.id, studentNpc);
          this.npcManager.fadeIn(studentNpc);
        }
      }
    }
    // Sub-agents missing from the latest snapshot have finished. Linger 2.5s
    // showing `done` so the user can see they completed, then fade out.
    for (const [, studentNpc] of studentMap) {
      if (incoming.has(studentNpc.def.id)) continue;
      if (studentNpc.despawnAt) continue;
      studentNpc.def.status = "done";
      studentNpc.def.dialogue = "Sub-task complete.";
      this.npcManager.refreshStatusBadge(studentNpc);
      studentNpc.despawnAt = this.time.now + 2500;
    }
  }

  private removeAgent(sessionId: string): void {
    const npc = this.teacherNpcs.get(sessionId);
    if (npc) {
      this.npcManager.destroy(npc);
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
      for (const s of students.values()) this.npcManager.destroy(s);
      this.studentNpcs.delete(sessionId);
    }
    if (this.dialogueOpenFor && this.dialogueOpenFor.def.id === sessionId) {
      this.closeDialogue();
    }
  }

  private agentToNpcDef(agent: AgentState, house: House, slot: number): NpcDef {
    const pos = teacherPosition(house, slot);
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
    return this.npcManager.spawn(def);
  }

  private tickSubAgentDespawns(now: number): void {
    for (const map of this.studentNpcs.values()) {
      for (const [id, npc] of Array.from(map.entries())) {
        if (npc.despawnAt && now >= npc.despawnAt) {
          map.delete(id);
          this.npcManager.fadeOutAndDestroy(npc);
        }
      }
    }
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
      this.npcManager.needsRightFlip("player") && this.playerLastDir === "right"
    );

    // NPC AI + overlays via the manager (handles wander, badge/glyph/bubble follow).
    const now = this.time.now;
    this.npcManager.updateAll(now, this.dialogueOpenFor);

    // Sub-agent despawn timer: a finished student lingers a short while in
    // `done` so the user can see they completed, then fades out.
    this.tickSubAgentDespawns(now);

    // Interaction prompt
    this.updateNearestNpc();
    this.updateDialogueInput();
  }

  private updateNearestNpc(): void {
    let best: NpcInstance | undefined;
    let bestDist = INTERACTION_RADIUS;
    for (const npc of this.npcManager.npcs) {
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
