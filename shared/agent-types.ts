/**
 * Shared types between server (Node) and client (Phaser scene).
 * Keep this file dependency-free.
 */

export type AgentStatus =
  | "planning"
  | "awaiting_approval"
  | "coding"
  | "running_tool"
  | "idle"
  | "done"
  | "blocked";

/** One option in an AskUserQuestion question. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** One question from an AskUserQuestion tool call. */
export interface PendingQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

export interface SubAgentState {
  /** Tool-use id of the parent `Task`/`Agent` call that spawned this subagent. */
  id: string;
  parentSessionId: string;
  status: AgentStatus;
  startedAt: number;
  /** Last tool the subagent invoked, if any. */
  currentTool?: string;
  /** Human-readable detail about the current tool (file path, command excerpt…). */
  currentToolDetail?: string;
  /** For Task tool: the description Claude gave (used as the subagent's "name"). */
  description?: string;
  /** True once the parent received the tool_result for this Task call. */
  finished: boolean;
}

export interface AgentState {
  /** Claude session UUID (== filename without .jsonl). */
  sessionId: string;
  /** Working directory the session is running in (= "project name"). */
  cwd: string;
  /** Short display name derived from cwd (last path component). */
  projectName: string;
  /** Path to the .jsonl file on disk. */
  filePath: string;
  status: AgentStatus;
  /** Last tool the agent invoked, used to compute status. */
  currentTool?: string;
  /** Human-readable detail about the current tool. */
  currentToolDetail?: string;
  startedAt: number;
  lastActivityAt: number;
  /** True once a `stop_hook_summary` is seen and no newer tool_use after. */
  turnEnded: boolean;
  subAgents: SubAgentState[];
  /** Populated when currentTool === 'ExitPlanMode'. Full plan markdown. */
  pendingPlan?: string;
  /** Populated when currentTool === 'AskUserQuestion'. Questions to display. */
  pendingQuestions?: PendingQuestion[];
}

export type ServerEvent =
  | { type: "snapshot"; agents: AgentState[] }
  | { type: "agent_spawned"; agent: AgentState }
  | { type: "agent_updated"; agent: AgentState }
  | { type: "agent_removed"; sessionId: string };
