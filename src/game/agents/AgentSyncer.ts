import Phaser from "phaser";
import { layerDepth } from "../config/grid";
import type { AgentState, SubAgentState } from "../../../shared/agent-types";
import {
  TEACHER_SPRITES,
  STUDENT_SPRITES,
  hashString,
} from "../../../shared/agent-sprites";
import { AgentSource } from "../services/agentSource";
import {
  HOUSES,
  STUDENT_OFFSETS,
  statusDialogue,
  teacherPosition,
  type House,
  type HouseState,
} from "../world/houseLayout";
import type { NpcDef, NpcInstance } from "./types";
import type { NpcManager } from "./NpcManager";
import type { DialogueUI } from "../ui/DialogueUI";

export type StatusSeverity = "info" | "warn";

export interface AgentSyncerCallbacks {
  /**
   * Called when the underlying SSE stream opens, closes, or the agent count
   * changes. `severity` lets the HUD pick a colour (warn = red, info = neutral).
   */
  onStatusChange?: (text: string, severity: StatusSeverity) => void;
}

/**
 * Bridge between the AgentSource (Claude session events) and the visual layer.
 * Owns the house bookkeeping (which project lives where) and the
 * teacher → students hierarchy. The scene calls `start()` once and never has
 * to look at session ids again.
 */
export class AgentSyncer {
  private readonly agentSource = new AgentSource();
  private readonly housesByCwd = new Map<string, HouseState>();
  private readonly usedHouseIds = new Set<string>();
  private readonly teacherNpcs = new Map<string, NpcInstance>();
  /** sessionId → (subAgentId → student NpcInstance). */
  private readonly studentNpcs = new Map<string, Map<string, NpcInstance>>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly npcManager: NpcManager,
    private readonly dialogue: DialogueUI,
    private readonly callbacks: AgentSyncerCallbacks = {}
  ) {}

  start(): void {
    this.agentSource.on("open", () => this.reportCount());
    this.agentSource.on("error", () =>
      this.report("⚠ /api/events disconnected — retrying…", "warn")
    );
    this.agentSource.on("snapshot", (agents) => {
      // Reset world and replay each agent through spawn.
      for (const sessionId of Array.from(this.teacherNpcs.keys())) {
        this.removeAgent(sessionId);
      }
      // Spawn most-recently-active agents first so the 3 houses always go to
      // the 3 cwds with the latest activity (not the 3 oldest cwds).
      const sorted = [...agents].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      for (const a of sorted) this.spawnAgent(a);
      this.reportCount();
    });
    this.agentSource.on("spawn", (a) => {
      this.spawnAgent(a);
      this.reportCount();
    });
    this.agentSource.on("update", (a) => this.updateAgent(a));
    this.agentSource.on("remove", (sessionId) => {
      this.removeAgent(sessionId);
      this.reportCount();
    });
    this.agentSource.start();
  }

  stop(): void {
    this.agentSource.stop();
  }

  /** Per-tick: fade out and despawn students that have lingered long enough. */
  tickDespawns(now: number): void {
    for (const map of this.studentNpcs.values()) {
      for (const [id, npc] of Array.from(map.entries())) {
        if (npc.despawnAt && now >= npc.despawnAt) {
          map.delete(id);
          this.npcManager.fadeOutAndDestroy(npc);
        }
      }
    }
  }

  /** Resolve an NPC by id (sessionId for teachers, sub-id for students). */
  findNpcById(id: string): NpcInstance | undefined {
    const teacher = this.teacherNpcs.get(id);
    if (teacher) return teacher;
    for (const map of this.studentNpcs.values()) {
      const npc = map.get(id);
      if (npc) return npc;
    }
    return undefined;
  }

  /** Resolve the house an NPC lives in. */
  findHouseForNpc(npc: NpcInstance): House | undefined {
    const isTeacher = npc.def.role !== "student";
    const sessionId = isTeacher ? npc.def.id : npc.def.parentId;
    if (!sessionId) return undefined;
    for (const state of this.housesByCwd.values()) {
      if (state.teachers.has(sessionId)) return state.house;
    }
    return undefined;
  }

  /**
   * True when no agent is in an urgent state (awaiting_approval or blocked).
   * Used to decide whether to show the "talk to Professor" invitation glyph.
   */
  allCalm(): boolean {
    if (this.teacherNpcs.size === 0) return true;
    for (const npc of this.teacherNpcs.values()) {
      const s = npc.def.status;
      if (s === "awaiting_approval" || s === "blocked") return false;
    }
    return true;
  }

  // ----- Internal: agent lifecycle -----

  private spawnAgent(agent: AgentState): void {
    if (this.teacherNpcs.has(agent.sessionId)) {
      this.updateAgent(agent);
      return;
    }
    if (!agent.cwd) return;
    const placement = this.assignToHouse(agent.cwd, agent.sessionId, agent.projectName, agent.lastActivityAt);
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

    // Keep the house recency fresh so eviction picks the right victim.
    const houseState = [...this.housesByCwd.values()].find(s => s.teachers.has(agent.sessionId));
    if (houseState && agent.lastActivityAt > houseState.lastActivityAt) {
      houseState.lastActivityAt = agent.lastActivityAt;
    }

    const prevTool = npc.def.currentTool;
    const prevDetail = npc.def.currentToolDetail;
    npc.def.status = agent.status;
    npc.def.name = agent.projectName;
    npc.def.currentTool = agent.currentTool;
    npc.def.currentToolDetail = agent.currentToolDetail;
    npc.def.dialogue = statusDialogue(agent);
    npc.def.pendingPlan = agent.pendingPlan;
    npc.def.pendingQuestions = agent.pendingQuestions;
    this.npcManager.refreshStatusBadge(npc);
    if (this.dialogue.openNpc === npc) this.dialogue.refresh(npc);
    if (prevTool !== agent.currentTool || prevDetail !== agent.currentToolDetail) {
      const persistent = agent.status === "coding" || agent.status === "running_tool";
      this.npcManager.showActivityBubble(npc, persistent);
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
        if (this.dialogue.openNpc === existing) this.dialogue.refresh(existing);
        if (
          subPrevTool !== sub.currentTool ||
          subPrevDetail !== sub.currentToolDetail
        ) {
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
      studentNpc.despawnAt = this.scene.time.now + 2500;
    }
  }

  private removeAgent(sessionId: string): void {
    const npc = this.teacherNpcs.get(sessionId);
    if (npc) {
      this.npcManager.destroy(npc);
      this.teacherNpcs.delete(sessionId);
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
    if (this.dialogue.openNpc && this.dialogue.openNpc.def.id === sessionId) {
      this.dialogue.close();
    }
  }

  // ----- Internal: house bookkeeping -----

  private assignToHouse(
    cwd: string,
    sessionId: string,
    projectName: string,
    lastActivityAt: number
  ): { house: House; slot: number } | null {
    let state = this.housesByCwd.get(cwd);
    if (!state) {
      const free = HOUSES.find((h) => !this.usedHouseIds.has(h.id));
      if (!free) {
        // All houses occupied — evict the least-recently-active cwd if this
        // one is newer than it, so the map always shows the 3 hottest projects.
        const evicted = this.evictLeastActiveHouse(lastActivityAt);
        if (!evicted) return null; // this cwd is older than all current ones
        // evicted house is now free
        const nowFree = HOUSES.find((h) => !this.usedHouseIds.has(h.id));
        if (!nowFree) return null;
        state = { house: nowFree, cwd, teachers: new Map(), lastActivityAt };
        state.label = this.makeHouseLabel(nowFree, projectName);
        this.housesByCwd.set(cwd, state);
        this.usedHouseIds.add(nowFree.id);
      } else {
        state = { house: free, cwd, teachers: new Map(), lastActivityAt };
        state.label = this.makeHouseLabel(free, projectName);
        this.housesByCwd.set(cwd, state);
        this.usedHouseIds.add(free.id);
      }
    } else {
      // Update recency so this house stays competitive on future eviction checks.
      if (lastActivityAt > state.lastActivityAt) state.lastActivityAt = lastActivityAt;
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

  /**
   * Find the cwd with the oldest lastActivityAt among occupied houses and
   * evict all its agents if `incomingActivity` is newer.
   * Returns true if an eviction happened, false if nothing was evicted.
   */
  private evictLeastActiveHouse(incomingActivity: number): boolean {
    let oldest: HouseState | null = null;
    for (const state of this.housesByCwd.values()) {
      if (!oldest || state.lastActivityAt < oldest.lastActivityAt) {
        oldest = state;
      }
    }
    if (!oldest || oldest.lastActivityAt >= incomingActivity) return false;
    // Remove all agents in that cwd's house.
    for (const sessionId of Array.from(oldest.teachers.keys())) {
      this.removeAgent(sessionId);
    }
    return true;
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
    return this.scene.add
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
  }

  // ----- Internal: def builders -----

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
      pendingPlan: agent.pendingPlan,
      pendingQuestions: agent.pendingQuestions,
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

  // ----- Internal: status callback plumbing -----

  private report(text: string, severity: StatusSeverity = "info"): void {
    this.callbacks.onStatusChange?.(text, severity);
  }

  private reportCount(): void {
    const n = this.teacherNpcs.size;
    this.report(`Connected • ${n} agent${n === 1 ? "" : "s"}`, "info");
  }
}
