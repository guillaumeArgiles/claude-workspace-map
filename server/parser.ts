import type { AgentStatus, SubAgentState } from "../shared/agent-types.js";

/**
 * Categorise a tool name into a Claude agent status.
 * Falls back to `running_tool` for unknown names.
 */
export function statusFromTool(toolName: string): AgentStatus {
  if (toolName === "ExitPlanMode") return "awaiting_approval";
  if (toolName === "AskUserQuestion") return "awaiting_approval";
  if (toolName === "Agent" || toolName === "Task") return "running_tool"; // parent spawning a subagent
  if (
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "NotebookEdit" ||
    toolName === "TodoWrite"
  ) {
    return "coding";
  }
  return "running_tool";
}

export interface AssistantToolUse {
  toolUseId: string;
  name: string;
  input?: unknown;
}

/**
 * Extract a short, human-readable description of what a tool call is doing,
 * derived from its input. Returns undefined when the tool has no useful detail.
 */
export function toolDetail(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const inp = input as Record<string, unknown>;
  const trim = (s: string, max = 80) =>
    s.length > max ? s.slice(0, max - 1) + "…" : s;
  const shortenPath = (p: string): string => {
    if (!p) return "";
    const noHome = p.replace(/^\/Users\/[^/]+\//, "~/");
    const parts = noHome.split("/");
    if (parts.length > 4) return ".../" + parts.slice(-2).join("/");
    return noHome;
  };

  switch (name) {
    case "Bash":
      return trim(String(inp.command ?? "").split("\n")[0]);
    case "Read":
      return shortenPath(String(inp.file_path ?? ""));
    case "Edit":
    case "Write":
      return shortenPath(String(inp.file_path ?? ""));
    case "NotebookEdit":
      return shortenPath(String(inp.notebook_path ?? ""));
    case "Grep":
      return trim(`pattern: ${String(inp.pattern ?? "")}`);
    case "Glob":
      return trim(`glob: ${String(inp.pattern ?? "")}`);
    case "WebFetch":
      return trim(String(inp.url ?? ""));
    case "WebSearch":
      return trim(`query: ${String(inp.query ?? "")}`);
    case "Task":
    case "Agent":
      return trim(String(inp.description ?? "(spawning subagent)"));
    case "ExitPlanMode": {
      const plan = String(inp.plan ?? "");
      const firstLine =
        plan.split("\n").find((l) => l.trim().length > 0) ?? "";
      return trim(firstLine.replace(/^#+\s*/, ""));
    }
    case "AskUserQuestion": {
      const q = inp.questions as Array<{ question?: string }> | undefined;
      if (Array.isArray(q) && q[0]?.question) return trim(q[0].question);
      return "Asking the user";
    }
    case "TodoWrite": {
      const todos = inp.todos as Array<{ status?: string }> | undefined;
      if (Array.isArray(todos)) {
        const ip = todos.filter((t) => t.status === "in_progress").length;
        const done = todos.filter((t) => t.status === "completed").length;
        return `${todos.length} todos · ${ip} active · ${done} done`;
      }
      return "Updating TODOs";
    }
    case "ToolSearch":
      return trim(`search: ${String(inp.query ?? "")}`);
    default:
      return undefined;
  }
}

export interface ParsedLine {
  raw: unknown;
  type: string;
  timestamp: number; // ms epoch
  isSidechain: boolean;
  cwd?: string;
  parentToolUseId?: string;
  toolUses: AssistantToolUse[];
  toolResultIds: string[];
  systemSubtype?: string;
  /** True if the last assistant content block was a stop_hook_summary. */
  isStopHook: boolean;
  hasText: boolean;
}

/**
 * Parse one JSONL line into a normalised event. Returns null for irrelevant lines
 * (queue-operation, attachment, ai-title, last-prompt …).
 */
export function parseLine(raw: string): ParsedLine | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }

  const type = String(obj.type ?? "");
  if (
    type === "queue-operation" ||
    type === "ai-title" ||
    type === "last-prompt" ||
    type === "attachment"
  ) {
    return null;
  }

  const timestamp = obj.timestamp ? Date.parse(String(obj.timestamp)) : Date.now();
  const isSidechain = Boolean(obj.isSidechain);
  const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
  const toolUses: AssistantToolUse[] = [];
  const toolResultIds: string[] = [];
  let isStopHook = false;
  let hasText = false;
  let systemSubtype: string | undefined;
  let parentToolUseId: string | undefined;

  if (type === "system") {
    systemSubtype =
      typeof obj.subtype === "string" ? obj.subtype : undefined;
  } else if (type === "assistant") {
    const message = obj.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message!.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      const bt = String(block.type ?? "");
      if (bt === "tool_use") {
        toolUses.push({
          toolUseId: String(block.id ?? ""),
          name: String(block.name ?? ""),
          input: block.input,
        });
      } else if (bt === "text") {
        hasText = true;
      }
    }
  } else if (type === "user") {
    const message = obj.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message!.content : [];
    for (const block of content as Array<Record<string, unknown>>) {
      const bt = String(block.type ?? "");
      if (bt === "tool_result") {
        toolResultIds.push(String(block.tool_use_id ?? ""));
        if (typeof block.tool_use_id === "string") {
          parentToolUseId = block.tool_use_id;
        }
      }
    }
  }

  if (systemSubtype === "stop_hook_summary") isStopHook = true;

  return {
    raw: obj,
    type,
    timestamp,
    isSidechain,
    cwd,
    parentToolUseId,
    toolUses,
    toolResultIds,
    systemSubtype,
    isStopHook,
    hasText,
  };
}

/**
 * Derive a status for the main agent from the most recent meaningful event.
 * Caller is expected to feed lines in chronological order.
 */
export function applyToAgentStatus(
  current: { status: AgentStatus; currentTool?: string; turnEnded: boolean },
  line: ParsedLine
): { status: AgentStatus; currentTool?: string; turnEnded: boolean } {
  let { status, currentTool, turnEnded } = current;

  if (line.systemSubtype === "api_error") {
    return { status: "blocked", currentTool, turnEnded: false };
  }
  if (line.isStopHook) {
    return { status: "idle", currentTool: undefined, turnEnded: true };
  }
  if (line.type === "assistant" && line.toolUses.length > 0) {
    const lastTool = line.toolUses[line.toolUses.length - 1];
    return {
      status: statusFromTool(lastTool.name),
      currentTool: lastTool.name,
      turnEnded: false,
    };
  }
  if (line.type === "assistant" && line.hasText) {
    if (status === "awaiting_approval") return { status, currentTool, turnEnded };
    return { status: "idle", currentTool, turnEnded };
  }
  return { status, currentTool, turnEnded };
}

/** Last tool_use of the line (used to compute the current tool detail). */
export function lastToolUse(line: ParsedLine): AssistantToolUse | undefined {
  if (line.type !== "assistant" || line.toolUses.length === 0) return undefined;
  return line.toolUses[line.toolUses.length - 1];
}

export interface SubAgentChange {
  kind: "spawn" | "finish" | "tool";
  toolUseId: string;
  toolName?: string;
}

/**
 * Detect subagent lifecycle events. Returns the changes implied by a single parsed line.
 *
 * - Main thread assistant invoking `Agent`/`Task` → spawn subagent (id = toolUseId).
 * - Side-channel (isSidechain) assistant tool_use → that subagent is doing `tool`.
 * - Main thread user tool_result for an Agent tool_use → finish subagent.
 */
export function subAgentChanges(line: ParsedLine, knownSubAgents: Set<string>): SubAgentChange[] {
  const changes: SubAgentChange[] = [];

  if (line.type === "assistant" && !line.isSidechain) {
    for (const tu of line.toolUses) {
      if (tu.name === "Agent" || tu.name === "Task") {
        changes.push({ kind: "spawn", toolUseId: tu.toolUseId, toolName: tu.name });
      }
    }
  }

  // Side-channel tool use: update the subagent's current tool. The subagent is identified
  // by whichever spawn we've already recorded — but JSONL doesn't directly link the
  // sidechain message to the originating Task tool_use_id. As a pragmatic heuristic, when
  // we have exactly one open subagent, attribute its activity to it.
  if (line.type === "assistant" && line.isSidechain && line.toolUses.length > 0) {
    const lastTool = line.toolUses[line.toolUses.length - 1];
    // Take any one open subagent (caller can refine later).
    for (const id of knownSubAgents) {
      changes.push({ kind: "tool", toolUseId: id, toolName: lastTool.name });
      break;
    }
  }

  if (line.type === "user" && !line.isSidechain) {
    for (const tid of line.toolResultIds) {
      if (knownSubAgents.has(tid)) {
        changes.push({ kind: "finish", toolUseId: tid });
      }
    }
  }

  return changes;
}

export function deriveSubAgentStatusFromTool(toolName: string): SubAgentState["status"] {
  return statusFromTool(toolName);
}
