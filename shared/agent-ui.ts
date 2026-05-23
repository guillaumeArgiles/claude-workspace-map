/**
 * UI constants shared between the Phaser scene and the React sidebar so we
 * stay consistent everywhere. The Phaser scene wants hex numbers (e.g.
 * 0xeab308), HTML wants the matching CSS strings. We expose both, generated
 * from the same source of truth.
 */

import type { AgentStatus } from "./agent-types";

/** CSS-friendly hex strings for HTML/React consumers. */
export const STATUS_COLOR: Record<AgentStatus, string> = {
  planning: "#3b82f6",         // blue
  awaiting_approval: "#eab308", // yellow
  coding: "#10b981",            // green
  running_tool: "#06b6d4",      // cyan
  idle: "#9ca3af",              // gray
  done: "#22c55e",              // lime
  blocked: "#ef4444",           // red
};

/** Phaser-friendly 0xRRGGBB numbers, derived from STATUS_COLOR. */
export const STATUS_COLOR_HEX: Record<AgentStatus, number> = Object.fromEntries(
  (Object.entries(STATUS_COLOR) as Array<[AgentStatus, string]>).map(
    ([status, css]) => [status, Number.parseInt(css.slice(1), 16)]
  )
) as Record<AgentStatus, number>;

export const STATUS_LABEL: Record<AgentStatus, string> = {
  planning: "Planning",
  awaiting_approval: "Awaiting approval",
  coding: "Coding",
  running_tool: "Running tool",
  idle: "Idle",
  done: "Done",
  blocked: "Blocked",
};

/**
 * Sort priority for surfacing agents that need attention. Lower = closer to
 * the top of the list.
 */
export function statusOrder(s: AgentStatus): number {
  switch (s) {
    case "awaiting_approval":
      return 0;
    case "blocked":
      return 1;
    case "running_tool":
    case "coding":
    case "planning":
      return 2;
    case "done":
      return 3;
    case "idle":
      return 4;
    default:
      return 5;
  }
}
