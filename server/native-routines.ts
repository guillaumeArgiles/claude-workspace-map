/**
 * Read-only parsers for Claude's own scheduled-tasks systems.
 *
 * Three sources exist on disk today (verified empirically on macOS) :
 *
 * 1. `~/.claude/scheduled-tasks/<id>/SKILL.md` — Claude Code MCP tasks.
 *    The `SKILL.md` has a frontmatter `{name, description}` + body prompt.
 *    Cron / enabled / lastRun are NOT stored here — those tasks are usually
 *    ad-hoc (manual trigger only).
 *
 * 2. `~/Library/Application Support/Claude/local-agent-mode-sessions/<orgId>/
 *    <userId>/scheduled-tasks.json` — Claude Desktop's local-agent mode.
 *    JSON `{scheduledTasks: [{id, cronExpression, enabled, filePath,
 *    createdAt, lastRunAt, ...}]}`. Prompts live at the `filePath`.
 *
 * 3. `~/Library/Application Support/Claude/claude-code-sessions/<orgId>/
 *    <userId>/scheduled-tasks.json` — same shape as (2), Claude Code mode.
 *
 * We surface all three as a flat `NativeRoutine[]` for the UI to display
 * grouped by `source`. No CRUD : Claude's own scheduler is the only thing
 * that should mutate these.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { NativeRoutine } from "../shared/routine-schema.js";
import { child } from "./logger.js";

const log = child("native-routines");

const HOME = os.homedir();

const CLAUDE_CODE_MCP_DIR = path.join(HOME, ".claude", "scheduled-tasks");
const LIBRARY_BASE = path.join(
  HOME,
  "Library",
  "Application Support",
  "Claude"
);

/** Max promptPreview length (chars). */
const PROMPT_PREVIEW_LIMIT = 200;

// ── Source 1 : ~/.claude/scheduled-tasks/<id>/SKILL.md ───────────────────────

/**
 * Parse a SKILL.md with YAML-ish frontmatter. We don't pull in a YAML lib;
 * the format is reliably `key: value` pairs only.
 */
function parseSkillMd(content: string): {
  fm: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { fm: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: match[2].trim() };
}

async function readClaudeCodeMcpRoutines(): Promise<NativeRoutine[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(CLAUDE_CODE_MCP_DIR);
  } catch {
    return [];
  }
  const routines: NativeRoutine[] = [];
  for (const entry of entries) {
    const filePath = path.join(CLAUDE_CODE_MCP_DIR, entry, "SKILL.md");
    try {
      const content = await fs.readFile(filePath, "utf8");
      const { fm, body } = parseSkillMd(content);
      routines.push({
        source: "claude-code-mcp",
        id: entry,
        name: fm.name ?? entry,
        description: fm.description,
        // The MCP system stores cron / enabled separately (in Claude.app's
        // state DB — not on disk). We can't see it from here, so we omit.
        promptPreview: body.slice(0, PROMPT_PREVIEW_LIMIT) || undefined,
        filePath,
      });
    } catch {
      /* skip unreadable entries */
    }
  }
  return routines;
}

// ── Sources 2 & 3 : ~/Library/.../<mode>-sessions/.../scheduled-tasks.json ───

interface LibraryIndexEntry {
  id?: string;
  cronExpression?: string;
  enabled?: boolean;
  filePath?: string;
  createdAt?: number;
  lastRunAt?: string;
}
interface LibraryIndexFile {
  scheduledTasks?: LibraryIndexEntry[];
}

async function findLibraryIndexFiles(modeDir: string): Promise<string[]> {
  const base = path.join(LIBRARY_BASE, modeDir);
  const found: string[] = [];
  try {
    const orgs = await fs.readdir(base, { withFileTypes: true });
    for (const org of orgs) {
      if (!org.isDirectory()) continue;
      const orgPath = path.join(base, org.name);
      try {
        const users = await fs.readdir(orgPath, { withFileTypes: true });
        for (const user of users) {
          if (!user.isDirectory()) continue;
          const candidate = path.join(orgPath, user.name, "scheduled-tasks.json");
          try {
            await fs.access(candidate);
            found.push(candidate);
          } catch {
            /* not present */
          }
        }
      } catch {
        /* unreadable org dir */
      }
    }
  } catch {
    /* mode dir missing — Claude Desktop not installed, etc. */
  }
  return found;
}

async function readLibraryRoutines(
  modeDir: string,
  source: NativeRoutine["source"]
): Promise<NativeRoutine[]> {
  const files = await findLibraryIndexFiles(modeDir);
  const routines: NativeRoutine[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as LibraryIndexFile;
      for (const entry of parsed.scheduledTasks ?? []) {
        if (!entry.id) continue;
        // Pull the prompt preview from the linked SKILL.md when available.
        let promptPreview: string | undefined;
        let name = entry.id;
        let description: string | undefined;
        if (entry.filePath) {
          try {
            const skillRaw = await fs.readFile(entry.filePath, "utf8");
            const { fm, body } = parseSkillMd(skillRaw);
            name = fm.name ?? name;
            description = fm.description;
            promptPreview = body.slice(0, PROMPT_PREVIEW_LIMIT) || undefined;
          } catch {
            /* skill file moved or deleted */
          }
        }
        const lastRunAtMs = entry.lastRunAt
          ? Date.parse(entry.lastRunAt) || undefined
          : undefined;
        routines.push({
          source,
          id: entry.id,
          name,
          description,
          cronExpression: entry.cronExpression,
          enabled: entry.enabled,
          lastRunAt: lastRunAtMs,
          promptPreview,
          filePath: entry.filePath,
        });
      }
    } catch (err) {
      log.warn({ err, file }, "failed to parse library scheduled-tasks.json");
    }
  }
  return routines;
}

// ── Public aggregator ────────────────────────────────────────────────────────

/**
 * Collect routines from all known Claude-native sources. Best-effort : any
 * unreachable / missing source is skipped silently (returns []).
 *
 * Returned ordering is :
 *   1. ~/.claude/scheduled-tasks (most relevant for Claude Code users)
 *   2. ~/Library/.../claude-code-sessions
 *   3. ~/Library/.../local-agent-mode-sessions (Claude Desktop)
 */
export async function listNativeRoutines(): Promise<NativeRoutine[]> {
  const [mcp, codeSessions, localAgent] = await Promise.all([
    readClaudeCodeMcpRoutines(),
    readLibraryRoutines("claude-code-sessions", "claude-code-sessions"),
    readLibraryRoutines("local-agent-mode-sessions", "claude-desktop"),
  ]);
  return [...mcp, ...codeSessions, ...localAgent];
}
