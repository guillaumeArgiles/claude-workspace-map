import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseLine, applyToAgentStatus, subAgentChanges, toolDetail, lastToolUse, statusFromTool } from "./parser.js";
import { child } from "./logger.js";
import type { AgentState, SubAgentState, PendingQuestion } from "../shared/agent-types.js";

const log = child("watcher");

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
/** A session is "active" if it had any activity within this many milliseconds. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

interface SessionTracker {
  filePath: string;
  byteOffset: number;
  agent: AgentState;
  /** Map of tool_use_id → subagent index in agent.subAgents. */
  subByToolUseId: Map<string, number>;
  /** Partial line at the tail of the file (when a write splits a line). */
  pending: string;
  /** tool_use_id of the last ExitPlanMode or AskUserQuestion call — cleared when
   *  the corresponding tool_result arrives so the approval widget disappears. */
  pendingApprovalToolId?: string;
}

export interface WatcherEvents {
  onSpawn(agent: AgentState): void;
  onUpdate(agent: AgentState): void;
  onRemove(sessionId: string): void;
}

export class SessionWatcher {
  private trackers = new Map<string, SessionTracker>();
  private watcher?: FSWatcher;
  /**
   * Sessions dismissed by the user: sessionId → byteOffset at dismissal time.
   * A dismissed session is re-shown only if its JSONL file grows beyond that
   * offset (new activity from a resumed agent).
   */
  private dismissed = new Map<string, number>();

  constructor(private events: WatcherEvents) {}

  /** Return active (recently touched) sessions, most recent first. */
  list(): AgentState[] {
    const now = Date.now();
    return Array.from(this.trackers.values())
      .map((t) => t.agent)
      .filter((a) => now - a.lastActivityAt < ACTIVE_WINDOW_MS)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  isActive(agent: AgentState): boolean {
    return Date.now() - agent.lastActivityAt < ACTIVE_WINDOW_MS;
  }

  /**
   * Apply a Claude Code hook event POSTed by the user's shell hooks. We mostly
   * rely on JSONL watching, but two events give us info the file alone can't
   * provide quickly:
   *   - Notification: Claude is waiting for the human (permission, idle prompt).
   *   - SessionEnd: explicit signal the session is over.
   */
  applyHookEvent(payload: Record<string, unknown>): void {
    const sessionId = String(payload.session_id ?? "");
    const event = String(payload.hook_event_name ?? "");
    if (!sessionId || !event) return;

    let tracker: SessionTracker | undefined;
    for (const t of this.trackers.values()) {
      if (t.agent.sessionId === sessionId) {
        tracker = t;
        break;
      }
    }
    if (!tracker) return;

    const now = Date.now();
    let changed = false;

    switch (event) {
      case "Notification": {
        tracker.agent.status = "awaiting_approval";
        tracker.agent.lastActivityAt = now;
        const msg = typeof payload.message === "string" ? payload.message.trim() : "";
        if (msg) tracker.agent.currentToolDetail = msg;
        changed = true;
        break;
      }
      case "SessionEnd": {
        tracker.agent.status = "done";
        tracker.agent.turnEnded = true;
        tracker.agent.currentTool = undefined;
        tracker.agent.currentToolDetail = undefined;
        tracker.agent.lastActivityAt = now;
        changed = true;
        break;
      }
      default:
        return;
    }

    if (changed && this.isActive(tracker.agent)) {
      this.events.onUpdate(tracker.agent);
    }
  }

  /**
   * Hide an agent from the sidebar. The tracker is removed immediately and
   * `onRemove` is fired. If the agent's JSONL file grows later (new activity),
   * it will be re-added automatically.
   */
  dismiss(sessionId: string): void {
    for (const [filePath, tracker] of this.trackers) {
      if (tracker.agent.sessionId === sessionId) {
        this.dismissed.set(sessionId, tracker.byteOffset);
        this.trackers.delete(filePath);
        this.events.onRemove(sessionId);
        return;
      }
    }
  }

  /**
   * Dismiss all agents matching `predicate`. Useful for bulk-clearing done/idle sessions.
   */
  dismissWhere(predicate: (agent: AgentState) => boolean): void {
    for (const [filePath, tracker] of this.trackers) {
      if (tracker.agent.cwd.includes(".claude-workspace-map")) continue; // never dismiss professor
      if (predicate(tracker.agent)) {
        this.dismissed.set(tracker.agent.sessionId, tracker.byteOffset);
        this.trackers.delete(filePath);
        this.events.onRemove(tracker.agent.sessionId);
      }
    }
  }

  async start(): Promise<void> {
    // chokidar v4+ removed glob support — watch the directory recursively
    // and filter by extension in the handlers.
    this.watcher = chokidar.watch(CLAUDE_PROJECTS_DIR, {
      persistent: true,
      ignoreInitial: false,
      depth: 99,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });

    const isJsonl = (p: string) => p.endsWith(".jsonl");

    this.watcher
      .on("add", (file: string) => {
        if (isJsonl(file))
          this.handleAddOrChange(file).catch((err: unknown) =>
            log.error({ err, file }, "add handler failed")
          );
      })
      .on("change", (file: string) => {
        if (isJsonl(file))
          this.handleAddOrChange(file).catch((err: unknown) =>
            log.error({ err, file }, "change handler failed")
          );
      })
      .on("unlink", (file: string) => {
        if (isJsonl(file)) this.handleRemove(file);
      })
      .on("ready", () => {
        log.info({ sessions: this.trackers.size }, "watcher ready");
      })
      .on("error", (err: unknown) => log.error({ err }, "watcher error"));

    log.info({ dir: CLAUDE_PROJECTS_DIR }, "watching projects directory");
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  private getOrCreate(filePath: string): SessionTracker {
    let tracker = this.trackers.get(filePath);
    if (tracker) return tracker;

    const sessionId = path.basename(filePath, ".jsonl");
    const dirName = path.basename(path.dirname(filePath));
    const now = Date.now();

    tracker = {
      filePath,
      byteOffset: 0,
      pending: "",
      subByToolUseId: new Map(),
      agent: {
        sessionId,
        // cwd starts blank, gets filled from the first JSONL line that carries it.
        cwd: "",
        // Fallback display name from the directory; replaced once cwd is known.
        projectName: dirName,
        filePath,
        status: "idle",
        startedAt: now,
        lastActivityAt: 0, // 0 until we actually parse a line
        turnEnded: false,
        subAgents: [],
      },
    };
    this.trackers.set(filePath, tracker);
    return tracker;
  }

  private async handleAddOrChange(filePath: string): Promise<void> {
    // Claude encodes the cwd into the project directory path — skip any session
    // whose JSONL lives under the professor workspace (.claude-workspace-map).
    // This prevents professor sessions from ever getting a house or dismiss button.
    if (filePath.includes("claude-workspace-map")) return;

    // If the user dismissed this session, only re-show it when new content arrives.
    const sessionId = path.basename(filePath, ".jsonl");
    const dismissedOffset = this.dismissed.get(sessionId);
    if (dismissedOffset !== undefined) {
      const peekStats = await fs.stat(filePath).catch(() => null);
      if (!peekStats || peekStats.size <= dismissedOffset) return; // no new content
      this.dismissed.delete(sessionId); // new activity — un-dismiss
    }

    const existed = this.trackers.has(filePath);
    const tracker = this.getOrCreate(filePath);
    const wasActiveBefore = existed && this.isActive(tracker.agent);

    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats) return;
    if (stats.size <= tracker.byteOffset) return;

    const fh = await fs.open(filePath, "r");
    try {
      const len = stats.size - tracker.byteOffset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, tracker.byteOffset);
      tracker.byteOffset = stats.size;
      const chunk = tracker.pending + buf.toString("utf8");
      const lines = chunk.split("\n");
      tracker.pending = lines.pop() ?? "";

      let anyChange = false;
      for (const ln of lines) {
        if (!ln.trim()) continue;
        const parsed = parseLine(ln);
        if (!parsed) continue;
        this.apply(tracker, parsed);
        anyChange = true;
      }

      const isActiveNow = this.isActive(tracker.agent);
      if (anyChange) {
        if (!wasActiveBefore && isActiveNow) this.events.onSpawn(tracker.agent);
        else if (isActiveNow) this.events.onUpdate(tracker.agent);
        else if (wasActiveBefore && !isActiveNow) this.events.onRemove(tracker.agent.sessionId);
      }
    } finally {
      await fh.close();
    }
  }

  private apply(tracker: SessionTracker, parsed: ReturnType<typeof parseLine>): void {
    if (!parsed) return;

    // Always update cwd from JSONL — it's authoritative and the dir name encoding lossy.
    if (parsed.cwd) {
      tracker.agent.cwd = parsed.cwd;
      tracker.agent.projectName = shortProjectName(parsed.cwd);
    }
    tracker.agent.lastActivityAt = parsed.timestamp;
    if (tracker.agent.startedAt === 0 || tracker.agent.lastActivityAt < tracker.agent.startedAt) {
      tracker.agent.startedAt = parsed.timestamp;
    }

    // Sub-agent changes
    const subChanges = subAgentChanges(parsed, new Set(tracker.subByToolUseId.keys()));
    const tu = lastToolUse(parsed);
    for (const ch of subChanges) {
      if (ch.kind === "spawn") {
        // For Task spawns, capture the description from the parent's tool_use input.
        const desc =
          tu && tu.toolUseId === ch.toolUseId
            ? (tu.input as { description?: string } | undefined)?.description
            : undefined;
        const sub: SubAgentState = {
          id: ch.toolUseId,
          parentSessionId: tracker.agent.sessionId,
          status: "running_tool",
          startedAt: parsed.timestamp,
          currentTool: ch.toolName,
          currentToolDetail: desc,
          description: desc,
          finished: false,
        };
        tracker.agent.subAgents.push(sub);
        tracker.subByToolUseId.set(ch.toolUseId, tracker.agent.subAgents.length - 1);
      } else if (ch.kind === "tool") {
        const idx = tracker.subByToolUseId.get(ch.toolUseId);
        if (idx !== undefined) {
          const sub = tracker.agent.subAgents[idx];
          sub.currentTool = ch.toolName;
          // Status reflects the actual tool (ExitPlanMode / AskUserQuestion →
          // awaiting_approval) instead of being hardcoded to running_tool.
          sub.status = ch.toolName ? statusFromTool(ch.toolName) : "running_tool";
          if (tu && ch.toolName) {
            sub.currentToolDetail = toolDetail(ch.toolName, tu.input);
          }
          // Pending approval data when the subagent prompts the user. Mirrors
          // the main-agent block below; cleared on any next tool (else branch).
          if (ch.toolName === "ExitPlanMode" && tu) {
            const inp = tu.input as Record<string, unknown> | undefined;
            sub.pendingPlan = inp?.plan ? String(inp.plan) : undefined;
            sub.pendingQuestions = undefined;
          } else if (ch.toolName === "AskUserQuestion" && tu) {
            const inp = tu.input as Record<string, unknown> | undefined;
            sub.pendingQuestions = inp?.questions as PendingQuestion[] | undefined;
            sub.pendingPlan = undefined;
          } else {
            // Subagent moved on to another tool → previous pending no longer applies.
            sub.pendingPlan = undefined;
            sub.pendingQuestions = undefined;
          }
        }
      } else if (ch.kind === "finish") {
        const idx = tracker.subByToolUseId.get(ch.toolUseId);
        if (idx !== undefined) {
          const sub = tracker.agent.subAgents[idx];
          sub.finished = true;
          sub.status = "done";
          sub.pendingPlan = undefined;
          sub.pendingQuestions = undefined;
        }
      }
    }

    // Main agent status (only from non-sidechain events)
    if (!parsed.isSidechain) {
      const next = applyToAgentStatus(
        { status: tracker.agent.status, currentTool: tracker.agent.currentTool, turnEnded: tracker.agent.turnEnded },
        parsed
      );
      tracker.agent.status = next.status;
      tracker.agent.currentTool = next.currentTool;
      tracker.agent.turnEnded = next.turnEnded;
      // currentToolDetail follows the last tool_use of the same line.
      if (tu && next.currentTool === tu.name) {
        tracker.agent.currentToolDetail = toolDetail(tu.name, tu.input);
      } else if (!next.currentTool) {
        tracker.agent.currentToolDetail = undefined;
      }

      // ── Pending approval data ─────────────────────────────────────────────
      // Populate pendingPlan / pendingQuestions when ExitPlanMode or
      // AskUserQuestion fires; clear them once the tool_result comes back
      // (agent answered) or the turn ends.
      if (tu?.name === "ExitPlanMode") {
        const inp = tu.input as Record<string, unknown> | undefined;
        tracker.agent.pendingPlan = inp?.plan ? String(inp.plan) : undefined;
        tracker.agent.pendingQuestions = undefined;
        tracker.pendingApprovalToolId = tu.toolUseId;
      } else if (tu?.name === "AskUserQuestion") {
        const inp = tu.input as Record<string, unknown> | undefined;
        tracker.agent.pendingQuestions = inp?.questions as PendingQuestion[] | undefined;
        tracker.agent.pendingPlan = undefined;
        tracker.pendingApprovalToolId = tu.toolUseId;
      } else if (
        tracker.pendingApprovalToolId &&
        parsed.toolResultIds.includes(tracker.pendingApprovalToolId)
      ) {
        // User replied — dismiss the widget immediately.
        tracker.agent.pendingPlan = undefined;
        tracker.agent.pendingQuestions = undefined;
        tracker.pendingApprovalToolId = undefined;
      } else if (next.turnEnded) {
        tracker.agent.pendingPlan = undefined;
        tracker.agent.pendingQuestions = undefined;
        tracker.pendingApprovalToolId = undefined;
      }
    }
  }

  private handleRemove(filePath: string): void {
    const tracker = this.trackers.get(filePath);
    if (!tracker) return;
    this.trackers.delete(filePath);
    this.events.onRemove(tracker.agent.sessionId);
  }
}

function shortProjectName(cwd: string): string {
  if (!cwd) return "unknown";
  const base = cwd.split("/").filter(Boolean).pop();
  return base ?? cwd;
}
