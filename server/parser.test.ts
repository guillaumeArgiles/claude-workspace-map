import { afterEach, describe, expect, it } from "vitest";
import {
  parseLine,
  applyToAgentStatus,
  toolDetail,
  statusFromTool,
  subAgentChanges,
  lastToolUse,
  setValidationErrorSink,
} from "./parser";
import type { AgentStatus } from "../shared/agent-types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function userLine(opts: {
  cwd?: string;
  toolResultIds?: string[];
  isSidechain?: boolean;
}): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-05-23T10:00:00.000Z",
    cwd: opts.cwd ?? "/tmp/proj",
    isSidechain: opts.isSidechain ?? false,
    message: {
      role: "user",
      content: (opts.toolResultIds ?? []).map((id) => ({
        type: "tool_result",
        tool_use_id: id,
        content: "ok",
      })),
    },
  });
}

function assistantLine(opts: {
  cwd?: string;
  toolUses?: Array<{ id: string; name: string; input?: unknown }>;
  text?: string;
  isSidechain?: boolean;
}): string {
  const content: Array<Record<string, unknown>> = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  for (const tu of opts.toolUses ?? []) {
    content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
  }
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-05-23T10:00:00.000Z",
    cwd: opts.cwd ?? "/tmp/proj",
    isSidechain: opts.isSidechain ?? false,
    message: { role: "assistant", content },
  });
}

function systemLine(subtype: string): string {
  return JSON.stringify({
    type: "system",
    timestamp: "2026-05-23T10:00:00.000Z",
    subtype,
    message: "",
  });
}

const baseStatus = {
  status: "idle" as AgentStatus,
  currentTool: undefined as string | undefined,
  turnEnded: false,
};

// ---------------------------------------------------------------------------
// parseLine
// ---------------------------------------------------------------------------

describe("parseLine", () => {
  it("ignores noise lines", () => {
    expect(parseLine(JSON.stringify({ type: "queue-operation" }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "attachment" }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "ai-title" }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "last-prompt" }))).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseLine("{ not json")).toBeNull();
  });

  it("parses an assistant message with tool_use + text blocks", () => {
    const parsed = parseLine(
      assistantLine({
        toolUses: [{ id: "tu_1", name: "Bash", input: { command: "ls" } }],
        text: "Listing the files.",
        cwd: "/Users/me/proj",
      })
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("assistant");
    expect(parsed!.cwd).toBe("/Users/me/proj");
    expect(parsed!.toolUses).toHaveLength(1);
    expect(parsed!.toolUses[0]).toMatchObject({ toolUseId: "tu_1", name: "Bash" });
    expect(parsed!.hasText).toBe(true);
    expect(parsed!.isSidechain).toBe(false);
  });

  it("parses a user tool_result", () => {
    const parsed = parseLine(userLine({ toolResultIds: ["tu_1", "tu_2"] }));
    expect(parsed!.type).toBe("user");
    expect(parsed!.toolResultIds).toEqual(["tu_1", "tu_2"]);
    expect(parsed!.parentToolUseId).toBe("tu_2"); // last wins by design
  });

  it("flags stop_hook_summary as a turn-end", () => {
    const parsed = parseLine(systemLine("stop_hook_summary"));
    expect(parsed!.isStopHook).toBe(true);
    expect(parsed!.systemSubtype).toBe("stop_hook_summary");
  });

  it("captures api_error subtype", () => {
    const parsed = parseLine(systemLine("api_error"));
    expect(parsed!.isStopHook).toBe(false);
    expect(parsed!.systemSubtype).toBe("api_error");
  });

  it("marks isSidechain on sub-agent assistant messages", () => {
    const parsed = parseLine(
      assistantLine({
        toolUses: [{ id: "sub_tool", name: "Read", input: { file_path: "/x" } }],
        isSidechain: true,
      })
    );
    expect(parsed!.isSidechain).toBe(true);
  });

  describe("Zod validation telemetry", () => {
    afterEach(() => setValidationErrorSink(undefined));

    it("rejects a JSONL line that is not an object (e.g. a bare string)", () => {
      const calls: Array<{ reason: string; raw: unknown }> = [];
      setValidationErrorSink((reason, raw) => calls.push({ reason, raw }));
      expect(parseLine(JSON.stringify("just a string"))).toBeNull();
      expect(calls).toHaveLength(1);
      expect(calls[0].raw).toBe("just a string");
    });

    it("rejects a line missing the required `type` field", () => {
      const calls: unknown[] = [];
      setValidationErrorSink(() => calls.push(1));
      expect(parseLine(JSON.stringify({ timestamp: "x", isSidechain: false }))).toBeNull();
      expect(calls).toHaveLength(1);
    });

    it("tolerates lines where `message` has an unexpected shape", () => {
      // Real-world: system lines sometimes carry `message: ""` instead of
      // an object. We should still get back a valid ParsedLine.
      const calls: unknown[] = [];
      setValidationErrorSink(() => calls.push(1));
      const parsed = parseLine(
        JSON.stringify({ type: "system", subtype: "stop_hook_summary", message: "" })
      );
      expect(parsed).not.toBeNull();
      expect(parsed!.isStopHook).toBe(true);
      expect(calls).toHaveLength(0); // soft validation, not flagged as error
    });

    it("doesn't fire the sink on malformed JSON (caught earlier)", () => {
      const calls: unknown[] = [];
      setValidationErrorSink(() => calls.push(1));
      expect(parseLine("not json {{{")).toBeNull();
      expect(calls).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// statusFromTool
// ---------------------------------------------------------------------------

describe("statusFromTool", () => {
  it("maps the plan-mode tools to awaiting_approval", () => {
    expect(statusFromTool("ExitPlanMode")).toBe("awaiting_approval");
    expect(statusFromTool("AskUserQuestion")).toBe("awaiting_approval");
  });

  it("maps file-edit tools to coding", () => {
    expect(statusFromTool("Edit")).toBe("coding");
    expect(statusFromTool("Write")).toBe("coding");
    expect(statusFromTool("NotebookEdit")).toBe("coding");
    expect(statusFromTool("TodoWrite")).toBe("coding");
  });

  it("falls back to running_tool for everything else", () => {
    expect(statusFromTool("Bash")).toBe("running_tool");
    expect(statusFromTool("Read")).toBe("running_tool");
    expect(statusFromTool("Grep")).toBe("running_tool");
    expect(statusFromTool("Glob")).toBe("running_tool");
    expect(statusFromTool("WebFetch")).toBe("running_tool");
    expect(statusFromTool("MysteryTool42")).toBe("running_tool");
  });

  it("treats Agent/Task as running_tool from the parent's perspective", () => {
    expect(statusFromTool("Agent")).toBe("running_tool");
    expect(statusFromTool("Task")).toBe("running_tool");
  });
});

// ---------------------------------------------------------------------------
// applyToAgentStatus
// ---------------------------------------------------------------------------

describe("applyToAgentStatus", () => {
  it("flips to blocked on api_error", () => {
    const line = parseLine(systemLine("api_error"))!;
    expect(applyToAgentStatus(baseStatus, line).status).toBe("blocked");
  });

  it("flips to idle + turnEnded on stop_hook_summary", () => {
    const line = parseLine(systemLine("stop_hook_summary"))!;
    const next = applyToAgentStatus(
      { status: "coding", currentTool: "Edit", turnEnded: false },
      line
    );
    expect(next).toEqual({ status: "idle", currentTool: undefined, turnEnded: true });
  });

  it("derives the status from the latest tool_use", () => {
    const line = parseLine(
      assistantLine({
        toolUses: [
          { id: "t1", name: "Read" },
          { id: "t2", name: "Edit" },
        ],
      })
    )!;
    expect(applyToAgentStatus(baseStatus, line)).toEqual({
      status: "coding",
      currentTool: "Edit",
      turnEnded: false,
    });
  });

  it("falls back to idle when the assistant only writes text", () => {
    const line = parseLine(assistantLine({ text: "Just thinking." }))!;
    expect(applyToAgentStatus({ status: "coding", currentTool: "Edit", turnEnded: false }, line))
      .toEqual({ status: "idle", currentTool: "Edit", turnEnded: false });
  });

  it("keeps awaiting_approval if the assistant only adds text afterwards", () => {
    const line = parseLine(assistantLine({ text: "Here's the plan." }))!;
    expect(
      applyToAgentStatus(
        { status: "awaiting_approval", currentTool: "ExitPlanMode", turnEnded: false },
        line
      )
    ).toEqual({ status: "awaiting_approval", currentTool: "ExitPlanMode", turnEnded: false });
  });

  it("ignores user tool_result lines (no status flip)", () => {
    const line = parseLine(userLine({ toolResultIds: ["t1"] }))!;
    const prev = { status: "running_tool" as AgentStatus, currentTool: "Bash", turnEnded: false };
    expect(applyToAgentStatus(prev, line)).toEqual(prev);
  });
});

// ---------------------------------------------------------------------------
// toolDetail
// ---------------------------------------------------------------------------

describe("toolDetail", () => {
  it("Bash → first line of the command, truncated past 80 chars", () => {
    expect(toolDetail("Bash", { command: "ls -la /tmp" })).toBe("ls -la /tmp");
    expect(toolDetail("Bash", { command: "echo hi\nrm -rf /" })).toBe("echo hi");
    const longCmd = "x".repeat(120);
    expect(toolDetail("Bash", { command: longCmd })?.endsWith("…")).toBe(true);
  });

  it("Read/Edit/Write → home-shortened path; deep paths get a .../ prefix", () => {
    // Short path (parts ≤ 4) keeps the ~ home shortening.
    expect(toolDetail("Read", { file_path: "/Users/me/proj/src/x.ts" })).toBe("~/proj/src/x.ts");
    expect(toolDetail("Edit", { file_path: "/etc/hosts" })).toBe("/etc/hosts");
    // Deep path (parts > 4) is trimmed to .../<last 2 segments>.
    expect(toolDetail("Write", { file_path: "/Users/alice/code/a/b/c.ts" })).toBe(".../b/c.ts");
    expect(toolDetail("NotebookEdit", { notebook_path: "/n.ipynb" })).toBe("/n.ipynb");
  });

  it("ExitPlanMode → first non-empty plan line, header stripped", () => {
    expect(toolDetail("ExitPlanMode", { plan: "# Refactor MapScene\nstep 1…" })).toBe(
      "Refactor MapScene"
    );
    expect(toolDetail("ExitPlanMode", { plan: "\n\n### Heading\nbody" })).toBe("Heading");
  });

  it("AskUserQuestion → first question text", () => {
    expect(
      toolDetail("AskUserQuestion", {
        questions: [
          { question: "Should we ship?" },
          { question: "Or rollback?" },
        ],
      })
    ).toBe("Should we ship?");
    expect(toolDetail("AskUserQuestion", {})).toBe("Asking the user");
  });

  it("TodoWrite → counts the todos by status", () => {
    expect(
      toolDetail("TodoWrite", {
        todos: [
          { status: "pending" },
          { status: "in_progress" },
          { status: "in_progress" },
          { status: "completed" },
        ],
      })
    ).toBe("4 todos · 2 active · 1 done");
  });

  it("Task/Agent → uses the description", () => {
    expect(toolDetail("Task", { description: "Run the tests" })).toBe("Run the tests");
    expect(toolDetail("Agent", { description: "Audit deps" })).toBe("Audit deps");
    expect(toolDetail("Task", {})).toBe("(spawning subagent)");
  });

  it("Web tools → URL or query", () => {
    expect(toolDetail("WebFetch", { url: "https://example.com" })).toBe(
      "https://example.com"
    );
    expect(toolDetail("WebSearch", { query: "pixel art" })).toBe("query: pixel art");
  });

  it("Grep/Glob → pattern", () => {
    expect(toolDetail("Grep", { pattern: "TODO" })).toBe("pattern: TODO");
    expect(toolDetail("Glob", { pattern: "**/*.ts" })).toBe("glob: **/*.ts");
  });

  it("unknown tool → undefined", () => {
    expect(toolDetail("MysteryTool", { foo: 1 })).toBeUndefined();
  });

  it("non-object input → undefined", () => {
    expect(toolDetail("Bash", null)).toBeUndefined();
    expect(toolDetail("Bash", undefined)).toBeUndefined();
    expect(toolDetail("Bash", "string")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// subAgentChanges
// ---------------------------------------------------------------------------

describe("subAgentChanges", () => {
  it("spawns a sub-agent on a non-sidechain Agent tool_use", () => {
    const line = parseLine(
      assistantLine({ toolUses: [{ id: "agent_1", name: "Agent" }] })
    )!;
    const changes = subAgentChanges(line, new Set());
    expect(changes).toEqual([{ kind: "spawn", toolUseId: "agent_1", toolName: "Agent" }]);
  });

  it("finishes a sub-agent when the parent receives its tool_result", () => {
    const line = parseLine(userLine({ toolResultIds: ["agent_1"] }))!;
    const changes = subAgentChanges(line, new Set(["agent_1"]));
    expect(changes).toEqual([{ kind: "finish", toolUseId: "agent_1" }]);
  });

  it("attributes sidechain tool activity to a known sub-agent", () => {
    const line = parseLine(
      assistantLine({
        toolUses: [{ id: "any", name: "Bash" }],
        isSidechain: true,
      })
    )!;
    const changes = subAgentChanges(line, new Set(["agent_1"]));
    expect(changes).toEqual([{ kind: "tool", toolUseId: "agent_1", toolName: "Bash" }]);
  });

  it("ignores sidechain activity when no sub-agent is open", () => {
    const line = parseLine(
      assistantLine({
        toolUses: [{ id: "any", name: "Bash" }],
        isSidechain: true,
      })
    )!;
    expect(subAgentChanges(line, new Set())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// lastToolUse
// ---------------------------------------------------------------------------

describe("lastToolUse", () => {
  it("returns undefined when there's no tool_use", () => {
    const line = parseLine(assistantLine({ text: "hello" }))!;
    expect(lastToolUse(line)).toBeUndefined();
  });

  it("returns the last tool_use of the line", () => {
    const line = parseLine(
      assistantLine({
        toolUses: [
          { id: "a", name: "Read" },
          { id: "b", name: "Edit" },
        ],
      })
    )!;
    expect(lastToolUse(line)?.name).toBe("Edit");
  });
});
