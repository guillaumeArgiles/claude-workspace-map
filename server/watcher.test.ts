import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionWatcher, type WatcherEvents } from "./watcher.js";
import type { AgentState } from "../shared/agent-types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * `handleAddOrChange` and `handleRemove` are private — the watcher normally
 * calls them from chokidar events. For unit tests we drive them directly with
 * a tmp file so we don't depend on filesystem-watcher timing. This typed
 * escape hatch documents the contract we lean on without intersecting with
 * SessionWatcher's own private members (which would collapse the type).
 */
type TestableWatcher = Omit<SessionWatcher, never> & {
  handleAddOrChange(filePath: string): Promise<void>;
  handleRemove(filePath: string): void;
};

interface EventLog {
  spawned: AgentState[];
  updated: AgentState[];
  removed: string[];
}

function newWatcher(): { watcher: TestableWatcher; events: EventLog } {
  const events: EventLog = { spawned: [], updated: [], removed: [] };
  const sink: WatcherEvents = {
    onSpawn: (agent) => events.spawned.push({ ...agent }),
    onUpdate: (agent) => events.updated.push({ ...agent }),
    onRemove: (sessionId) => events.removed.push(sessionId),
  };
  return {
    watcher: new SessionWatcher(sink) as unknown as TestableWatcher,
    events,
  };
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Compose a JSONL line for an `assistant` tool_use call. */
function assistantToolUse(opts: {
  cwd?: string;
  toolUseId: string;
  toolName: string;
  input?: unknown;
  isSidechain?: boolean;
  timestampOffsetMs?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: nowIso(opts.timestampOffsetMs),
    cwd: opts.cwd ?? "/tmp/projA",
    isSidechain: opts.isSidechain ?? false,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: opts.toolUseId,
          name: opts.toolName,
          input: opts.input ?? {},
        },
      ],
    },
  });
}

function userToolResult(opts: {
  toolUseId: string;
  isSidechain?: boolean;
  timestampOffsetMs?: number;
}): string {
  return JSON.stringify({
    type: "user",
    timestamp: nowIso(opts.timestampOffsetMs),
    cwd: "/tmp/projA",
    isSidechain: opts.isSidechain ?? false,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: opts.toolUseId, content: "ok" },
      ],
    },
  });
}

function systemLine(subtype: string, timestampOffsetMs = 0): string {
  return JSON.stringify({
    type: "system",
    timestamp: nowIso(timestampOffsetMs),
    subtype,
    message: "",
  });
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "map-watcher-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeSession(sessionId: string, lines: string[]): Promise<string> {
  const file = path.join(tmpRoot, `${sessionId}.jsonl`);
  await fs.writeFile(file, lines.join("\n") + (lines.length ? "\n" : ""));
  return file;
}

async function appendSession(file: string, lines: string[]): Promise<void> {
  await fs.appendFile(file, lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------

describe("SessionWatcher", () => {
  describe("filesystem ingestion", () => {
    it("spawns an agent on the first add of a fresh JSONL", async () => {
      const { watcher, events } = newWatcher();
      const file = await writeSession("sess-1", [
        assistantToolUse({ toolUseId: "tu1", toolName: "Bash", input: { command: "ls" } }),
      ]);
      await watcher.handleAddOrChange(file);
      expect(events.spawned).toHaveLength(1);
      expect(events.updated).toHaveLength(0);
      expect(events.spawned[0].sessionId).toBe("sess-1");
      expect(events.spawned[0].cwd).toBe("/tmp/projA");
      expect(events.spawned[0].projectName).toBe("projA");
      expect(events.spawned[0].currentTool).toBe("Bash");
    });

    it("emits onUpdate on subsequent changes (not onSpawn again)", async () => {
      const { watcher, events } = newWatcher();
      const file = await writeSession("sess-1", [
        assistantToolUse({ toolUseId: "tu1", toolName: "Bash", input: { command: "ls" } }),
      ]);
      await watcher.handleAddOrChange(file);
      events.spawned.length = 0;
      events.updated.length = 0;

      await appendSession(file, [
        assistantToolUse({ toolUseId: "tu2", toolName: "Edit", input: { file_path: "/a.ts" } }),
      ]);
      await watcher.handleAddOrChange(file);

      expect(events.spawned).toHaveLength(0);
      expect(events.updated).toHaveLength(1);
      expect(events.updated[0].currentTool).toBe("Edit");
      expect(events.updated[0].status).toBe("coding");
    });

    it("dedups by byte offset — re-reading the same file is a no-op", async () => {
      const { watcher, events } = newWatcher();
      const file = await writeSession("sess-1", [
        assistantToolUse({ toolUseId: "tu1", toolName: "Bash" }),
      ]);
      await watcher.handleAddOrChange(file);
      const spawnsAfterFirst = events.spawned.length;
      const updatesAfterFirst = events.updated.length;

      // Same file, same size → nothing new to read.
      await watcher.handleAddOrChange(file);
      await watcher.handleAddOrChange(file);

      expect(events.spawned).toHaveLength(spawnsAfterFirst);
      expect(events.updated).toHaveLength(updatesAfterFirst);
    });

    it("handles a write that splits a line across two reads (pending buffer)", async () => {
      const { watcher, events } = newWatcher();
      const file = path.join(tmpRoot, "sess-1.jsonl");
      const full = assistantToolUse({ toolUseId: "tu1", toolName: "Bash" });
      // Write the first half of the line, no trailing newline.
      const split = Math.floor(full.length / 2);
      await fs.writeFile(file, full.slice(0, split));
      await watcher.handleAddOrChange(file);

      // No complete line yet → no agent should have spawned.
      expect(events.spawned).toHaveLength(0);

      // Append the rest + newline → the line is now complete.
      await fs.appendFile(file, full.slice(split) + "\n");
      await watcher.handleAddOrChange(file);
      expect(events.spawned).toHaveLength(1);
      expect(events.spawned[0].currentTool).toBe("Bash");
    });

    it("removes the agent on unlink", async () => {
      const { watcher, events } = newWatcher();
      const file = await writeSession("sess-1", [
        assistantToolUse({ toolUseId: "tu1", toolName: "Bash" }),
      ]);
      await watcher.handleAddOrChange(file);
      expect(events.spawned).toHaveLength(1);

      // The public surface routes through chokidar 'unlink'; we exercise the
      // private handler via the same escape hatch.
      watcher.handleRemove(file);
      expect(events.removed).toEqual(["sess-1"]);
    });

    it("missing files are tolerated (race between watcher event and unlink)", async () => {
      const { watcher, events } = newWatcher();
      const file = path.join(tmpRoot, "ghost.jsonl");
      await expect(watcher.handleAddOrChange(file)).resolves.toBeUndefined();
      expect(events.spawned).toHaveLength(0);
    });
  });

  describe("status + tool detail", () => {
    it("derives status `coding` from an Edit tool_use", async () => {
      const { watcher, events } = newWatcher();
      const file = await writeSession("sess-1", [
        assistantToolUse({ toolUseId: "tu1", toolName: "Edit", input: { file_path: "/x.ts" } }),
      ]);
      await watcher.handleAddOrChange(file);
      expect(events.spawned[0].status).toBe("coding");
      expect(events.spawned[0].currentToolDetail).toBeDefined();
    });

    it("flips to `idle` + turnEnded on a stop_hook_summary system line", async () => {
      const { watcher, events } = newWatcher();
      const file = await writeSession("sess-1", [
        assistantToolUse({ toolUseId: "tu1", toolName: "Bash" }),
        systemLine("stop_hook_summary", 1000),
      ]);
      await watcher.handleAddOrChange(file);
      const agent = events.spawned[0];
      expect(agent.status).toBe("idle");
      expect(agent.turnEnded).toBe(true);
      expect(agent.currentTool).toBeUndefined();
    });

    it("ignores sidechain (sub-agent) lines for the main agent status", async () => {
      const { watcher, events } = newWatcher();
      const file = await writeSession("sess-1", [
        // Main spawns a Task.
        assistantToolUse({
          toolUseId: "task1",
          toolName: "Task",
          input: { description: "investigate auth bug" },
        }),
        // The sub-agent does its own thing — should NOT change main's currentTool.
        assistantToolUse({
          toolUseId: "subtool1",
          toolName: "Grep",
          input: { pattern: "auth" },
          isSidechain: true,
          timestampOffsetMs: 100,
        }),
      ]);
      await watcher.handleAddOrChange(file);
      const agent = events.spawned[0];
      expect(agent.currentTool).toBe("Task"); // main is still in Task
      expect(agent.subAgents).toHaveLength(1);
      expect(agent.subAgents[0].description).toBe("investigate auth bug");
      expect(agent.subAgents[0].currentTool).toBe("Grep");
    });
  });

  describe("sub-agent lifecycle", () => {
    it("spawns → tool → finish", async () => {
      const { watcher, events } = newWatcher();
      const file = await writeSession("sess-1", [
        assistantToolUse({
          toolUseId: "task1",
          toolName: "Task",
          input: { description: "build a feature" },
        }),
        assistantToolUse({
          toolUseId: "subtool1",
          toolName: "Read",
          input: { file_path: "/x.ts" },
          isSidechain: true,
          timestampOffsetMs: 100,
        }),
        userToolResult({ toolUseId: "task1", timestampOffsetMs: 200 }),
      ]);
      await watcher.handleAddOrChange(file);
      const agent = events.spawned[0];
      expect(agent.subAgents).toHaveLength(1);
      const sub = agent.subAgents[0];
      expect(sub.id).toBe("task1");
      expect(sub.description).toBe("build a feature");
      expect(sub.currentTool).toBe("Read");
      expect(sub.finished).toBe(true);
      expect(sub.status).toBe("done");
    });
  });

  describe("applyHookEvent", () => {
    it("flips to awaiting_approval on a Notification", async () => {
      const { watcher, events } = newWatcher();
      const file = await writeSession("sess-1", [
        assistantToolUse({ toolUseId: "tu1", toolName: "Bash" }),
      ]);
      await watcher.handleAddOrChange(file);
      events.updated.length = 0;

      watcher.applyHookEvent({
        session_id: "sess-1",
        hook_event_name: "Notification",
        message: "Permission to run rm -rf?",
      });

      expect(events.updated).toHaveLength(1);
      expect(events.updated[0].status).toBe("awaiting_approval");
      expect(events.updated[0].currentToolDetail).toBe("Permission to run rm -rf?");
    });

    it("flips to done + turnEnded on a SessionEnd", async () => {
      const { watcher, events } = newWatcher();
      const file = await writeSession("sess-1", [
        assistantToolUse({ toolUseId: "tu1", toolName: "Bash" }),
      ]);
      await watcher.handleAddOrChange(file);
      events.updated.length = 0;

      watcher.applyHookEvent({ session_id: "sess-1", hook_event_name: "SessionEnd" });

      expect(events.updated).toHaveLength(1);
      expect(events.updated[0].status).toBe("done");
      expect(events.updated[0].turnEnded).toBe(true);
      expect(events.updated[0].currentTool).toBeUndefined();
    });

    it("is a no-op for unknown sessionId", async () => {
      const { watcher, events } = newWatcher();
      watcher.applyHookEvent({
        session_id: "does-not-exist",
        hook_event_name: "SessionEnd",
      });
      expect(events.updated).toHaveLength(0);
    });

    it("is a no-op for unknown event names", async () => {
      const { watcher, events } = newWatcher();
      const file = await writeSession("sess-1", [
        assistantToolUse({ toolUseId: "tu1", toolName: "Bash" }),
      ]);
      await watcher.handleAddOrChange(file);
      events.updated.length = 0;

      watcher.applyHookEvent({ session_id: "sess-1", hook_event_name: "MysteryHook" });
      expect(events.updated).toHaveLength(0);
    });

    it("ignores payloads missing session_id or hook_event_name", () => {
      const { watcher, events } = newWatcher();
      watcher.applyHookEvent({});
      watcher.applyHookEvent({ session_id: "x" });
      watcher.applyHookEvent({ hook_event_name: "Notification" });
      expect(events.updated).toHaveLength(0);
    });
  });

  describe("list / isActive", () => {
    it("returns only sessions touched within the active window, newest first", async () => {
      const { watcher } = newWatcher();
      const fileA = await writeSession("sess-A", [
        assistantToolUse({ toolUseId: "a", toolName: "Bash", timestampOffsetMs: -1000 }),
      ]);
      const fileB = await writeSession("sess-B", [
        assistantToolUse({ toolUseId: "b", toolName: "Bash", timestampOffsetMs: 0 }),
      ]);
      await watcher.handleAddOrChange(fileA);
      await watcher.handleAddOrChange(fileB);

      const list = watcher.list();
      expect(list.map((a) => a.sessionId)).toEqual(["sess-B", "sess-A"]);
    });

    it("filters out sessions whose last activity is past the 30-minute window", async () => {
      const { watcher } = newWatcher();
      const file = await writeSession("sess-old", [
        // 31 minutes ago
        assistantToolUse({ toolUseId: "a", toolName: "Bash", timestampOffsetMs: -31 * 60 * 1000 }),
      ]);
      await watcher.handleAddOrChange(file);
      expect(watcher.list()).toHaveLength(0);
    });
  });
});
