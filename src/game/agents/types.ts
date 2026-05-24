import type { AgentStatus, PendingQuestion } from "../../../shared/agent-types";

/** Cardinal direction used to drive the 4-direction RPG-Maker animations. */
export type Direction = "down" | "left" | "right" | "up";

export interface NpcDef {
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
  /** Override the "[E] parler à {name}" prompt (e.g. "parler au Professeur"). */
  interactLabel?: string;
  /** Filename (without extension) under /assets/sprites/. */
  sprite: string;
  /** Override hair colour for programmatic sprites (hex string). */
  hairColor?: string;
  /** Override clothes colour for programmatic sprites (hex string). */
  clothesColor?: string;
  /** If true, the NPC stays at its home position and doesn't wander. */
  static?: boolean;
  /** Populated when the agent is waiting on ExitPlanMode approval. */
  pendingPlan?: string;
  /** Populated when the agent is waiting on AskUserQuestion. */
  pendingQuestions?: PendingQuestion[];
}

export interface NpcInstance {
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
  /** Floating ? / ! glyph for awaiting_approval or blocked statuses. */
  statusGlyph?: Phaser.GameObjects.Container;
  /** When set, the sub-agent should be despawned at this time (post-done linger). */
  despawnAt?: number;
}
