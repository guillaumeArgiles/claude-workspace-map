import type { AgentState, SubAgentState } from "../../../shared/agent-types";
import { t } from "../../i18n";

/**
 * A "house" is a slot on the map that a Claude project (cwd) can claim.
 * Several teachers / sessions on the same project share the same house, each
 * with a different `slot` index inside it.
 */
export interface House {
  id: string;
  building: string;
  /** Centre where the main agent (teacher) wanders around. */
  center: { x: number; y: number };
  /** Point on the path right outside the stairs — used as a waypoint for auto-walk. */
  entrance: { x: number; y: number };
}

export interface HouseState {
  house: House;
  cwd: string;
  /** sessionId → slot index used to position the teacher inside the house. */
  teachers: Map<string, number>;
  /** Project name banner rendered above the house. */
  label?: Phaser.GameObjects.Text;
  /** Most recent lastActivityAt across all sessions in this cwd — used to evict
   *  the least-active house when all slots are taken and a more recent cwd arrives. */
  lastActivityAt: number;
}

/**
 * Three houses, one per Claude project (max). Entrance coordinates are the
 * gap in the bottom collision wall of each building — derived from the
 * collisions.json hand-drawn rectangles:
 *   Claude gap     x ≈ 266 → 325 → center 295
 *   Review gap     x ≈ 667 → 728 → center 697
 *   Monitoring gap x ≈ 1090 → 1160 → center 1125
 *
 * Center y values are chosen from NavGrid analysis (cellSize=24, margin=24):
 *   - house_claude: new_4 (desk) removed from collisions.json → interior walkable at y=260
 *   - house_review: new_16+17 (tables) removed from collisions.json → interior walkable at y=280
 *   - house_monitoring has walkable interior cells → use interior (y=330)
 */
export const HOUSES: House[] = [
  {
    id: "house_claude",
    building: "CLAUDE",
    center: { x: 290, y: 260 },
    entrance: { x: 295, y: 450 },
  },
  {
    id: "house_review",
    building: "REVIEW",
    center: { x: 720, y: 280 },
    entrance: { x: 697, y: 450 },
  },
  {
    id: "house_monitoring",
    building: "MONITORING",
    center: { x: 1150, y: 330 },
    entrance: { x: 1125, y: 450 },
  },
];

/** Where each successive teacher stands inside the same house. */
export const TEACHER_SLOT_OFFSETS: Array<{ dx: number; dy: number }> = [
  { dx: 0, dy: 0 },
  { dx: -90, dy: 30 },
  { dx: 90, dy: 30 },
  { dx: -45, dy: -50 },
  { dx: 45, dy: -50 },
];

/** Offsets around the teacher's home where students wander. */
export const STUDENT_OFFSETS: Array<{ dx: number; dy: number }> = [
  { dx: -70, dy: 40 },
  { dx: 70, dy: 40 },
  { dx: -70, dy: -30 },
  { dx: 70, dy: -30 },
  { dx: 0, dy: 60 },
  { dx: 0, dy: -50 },
  { dx: -100, dy: 0 },
  { dx: 100, dy: 0 },
];

/** World-coordinate position of the teacher in `slot` inside `house`. */
export function teacherPosition(
  house: House,
  slot: number
): { x: number; y: number } {
  const offset = TEACHER_SLOT_OFFSETS[slot % TEACHER_SLOT_OFFSETS.length];
  return { x: house.center.x + offset.dx, y: house.center.y + offset.dy };
}

/**
 * Default dialogue line for an agent/sub-agent, derived from its current
 * status. The richer `currentToolDetail` (Bash command, file path, plan
 * title…) wins when present.
 */
export function statusDialogue(agent: AgentState | SubAgentState): string {
  if (agent.currentToolDetail) return agent.currentToolDetail;
  const tool = agent.currentTool ? ` (${agent.currentTool})` : "";
  switch (agent.status) {
    case "planning":
      return t("dialogue.status.planning");
    case "awaiting_approval":
      return t("dialogue.status.awaiting_approval");
    case "coding":
      return t("dialogue.status.coding", { tool });
    case "running_tool":
      return t("dialogue.status.running_tool", {
        tool: agent.currentTool || t("dialogue.status.running_tool_fallback"),
      });
    case "idle":
      return t("dialogue.status.idle");
    case "done":
      return t("dialogue.status.done");
    case "blocked":
      return t("dialogue.status.blocked");
    default:
      return t("dialogue.status.default");
  }
}
