import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { CLAUDE_PROJECTS_DIR } from "./watcher.js";

export interface TokensByModelEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface StatsResponse {
  range: { from: number; to: number };
  projects: string[];
  totals: {
    sessions: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    tokensByModel: Record<string, TokensByModelEntry>;
    toolCalls: number;
    plansProposed: number;
    plansAccepted: number;
  };
  topTools: Array<{ name: string; count: number }>;
  topProjects: Array<{ cwd: string; sessions: number; tokens: number }>;
  sessionsPerDay: Array<{ date: string; sessions: number }>;
}

interface ProjectAccum {
  sessions: Set<string>;
  tokens: number;
}

interface Accum {
  sessionsAll: Set<string>;
  sessionsPerDay: Map<string, Set<string>>;
  perProject: Map<string, ProjectAccum>;
  projectsSeen: Set<string>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  tokensByModel: Map<string, TokensByModelEntry>;
  toolCounts: Map<string, number>;
  toolCalls: number;
  plansProposed: number;
  plansAccepted: number;
}

const APPROVED_PREFIX = "User has approved your plan";

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function bumpModelTokens(
  map: Map<string, TokensByModelEntry>,
  model: string,
  usage: Record<string, unknown>,
): void {
  const entry = map.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  entry.input += Number(usage.input_tokens ?? 0) || 0;
  entry.output += Number(usage.output_tokens ?? 0) || 0;
  entry.cacheRead += Number(usage.cache_read_input_tokens ?? 0) || 0;
  entry.cacheCreation += Number(usage.cache_creation_input_tokens ?? 0) || 0;
  map.set(model, entry);
}

/** Walk one JSONL file, accumulate into `acc`. Per-file state for plan tracking. */
async function processFile(
  filePath: string,
  from: number,
  to: number,
  projectFilter: string | undefined,
  acc: Accum,
): Promise<void> {
  const pendingPlans = new Set<string>();

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const raw of rl) {
    if (!raw) continue;
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    const tsRaw = line.timestamp;
    if (typeof tsRaw !== "string") continue;
    const ts = Date.parse(tsRaw);
    if (!Number.isFinite(ts)) continue;
    if (ts < from || ts > to) continue;

    const cwd = typeof line.cwd === "string" ? line.cwd : undefined;
    if (projectFilter && cwd !== projectFilter) continue;
    if (cwd) acc.projectsSeen.add(cwd);

    const sessionId = typeof line.sessionId === "string" ? line.sessionId : undefined;
    if (sessionId) {
      acc.sessionsAll.add(sessionId);
      const day = isoDate(ts);
      let set = acc.sessionsPerDay.get(day);
      if (!set) {
        set = new Set();
        acc.sessionsPerDay.set(day, set);
      }
      set.add(sessionId);
      if (cwd) {
        let p = acc.perProject.get(cwd);
        if (!p) {
          p = { sessions: new Set(), tokens: 0 };
          acc.perProject.set(cwd, p);
        }
        p.sessions.add(sessionId);
      }
    }

    const type = line.type;
    const message = line.message as Record<string, unknown> | undefined;

    if (type === "assistant" && message) {
      const model = typeof message.model === "string" ? message.model : "unknown";
      const usage = message.usage as Record<string, unknown> | undefined;
      if (usage) {
        const inp = Number(usage.input_tokens ?? 0) || 0;
        const out = Number(usage.output_tokens ?? 0) || 0;
        const cr = Number(usage.cache_read_input_tokens ?? 0) || 0;
        const cc = Number(usage.cache_creation_input_tokens ?? 0) || 0;
        acc.inputTokens += inp;
        acc.outputTokens += out;
        acc.cacheReadTokens += cr;
        acc.cacheCreationTokens += cc;
        bumpModelTokens(acc.tokensByModel, model, usage);
        if (cwd) {
          const p = acc.perProject.get(cwd);
          if (p) p.tokens += inp + out + cr + cc;
        }
      }

      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "tool_use" && typeof b.name === "string") {
            acc.toolCalls += 1;
            acc.toolCounts.set(b.name, (acc.toolCounts.get(b.name) ?? 0) + 1);
            if (b.name === "ExitPlanMode" && typeof b.id === "string") {
              acc.plansProposed += 1;
              pendingPlans.add(b.id);
            }
          }
        }
      }
    } else if (type === "user" && message) {
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result" && typeof b.tool_use_id === "string"
              && pendingPlans.has(b.tool_use_id)) {
            pendingPlans.delete(b.tool_use_id);
            const c = b.content;
            let text = "";
            if (typeof c === "string") text = c;
            else if (Array.isArray(c) && c[0] && typeof c[0] === "object") {
              const first = c[0] as Record<string, unknown>;
              if (typeof first.text === "string") text = first.text;
            }
            if (text.startsWith(APPROVED_PREFIX)) acc.plansAccepted += 1;
          }
        }
      }
    }
  }
}

export interface AggregateOptions {
  from?: number;
  to?: number;
  projectCwd?: string;
}

export async function aggregateStats(opts: AggregateOptions = {}): Promise<StatsResponse> {
  const to = opts.to ?? Date.now();
  const from = opts.from ?? to - 30 * 24 * 60 * 60 * 1000;
  const projectFilter = opts.projectCwd;

  const acc: Accum = {
    sessionsAll: new Set(),
    sessionsPerDay: new Map(),
    perProject: new Map(),
    projectsSeen: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    tokensByModel: new Map(),
    toolCounts: new Map(),
    toolCalls: 0,
    plansProposed: 0,
    plansAccepted: 0,
  };

  let projectDirs: string[];
  try {
    projectDirs = await fsp.readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    projectDirs = [];
  }

  for (const dirName of projectDirs) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
    let entries: string[];
    try {
      entries = await fsp.readdir(dirPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = path.join(dirPath, entry);
      let st: fs.Stats;
      try {
        st = await fsp.stat(filePath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      // mtime is the time of the last appended line. If it's before `from`,
      // no line in the file can fall in the range.
      if (st.mtimeMs < from) continue;
      try {
        await processFile(filePath, from, to, projectFilter, acc);
      } catch {
        // skip unreadable files
      }
    }
  }

  // Sessions/day, 0-filled across the range
  const sessionsPerDay: Array<{ date: string; sessions: number }> = [];
  const dayMs = 24 * 60 * 60 * 1000;
  const fromDay = Date.UTC(
    new Date(from).getUTCFullYear(),
    new Date(from).getUTCMonth(),
    new Date(from).getUTCDate(),
  );
  const toDay = Date.UTC(
    new Date(to).getUTCFullYear(),
    new Date(to).getUTCMonth(),
    new Date(to).getUTCDate(),
  );
  for (let d = fromDay; d <= toDay; d += dayMs) {
    const key = isoDate(d);
    sessionsPerDay.push({ date: key, sessions: acc.sessionsPerDay.get(key)?.size ?? 0 });
  }

  const topTools = Array.from(acc.toolCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const topProjects = Array.from(acc.perProject.entries())
    .map(([cwd, p]) => ({ cwd, sessions: p.sessions.size, tokens: p.tokens }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);

  const tokensByModel: Record<string, TokensByModelEntry> = {};
  for (const [model, entry] of acc.tokensByModel.entries()) {
    tokensByModel[model] = entry;
  }

  return {
    range: { from, to },
    projects: Array.from(acc.projectsSeen).sort(),
    totals: {
      sessions: acc.sessionsAll.size,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens,
      tokensByModel,
      toolCalls: acc.toolCalls,
      plansProposed: acc.plansProposed,
      plansAccepted: acc.plansAccepted,
    },
    topTools,
    topProjects,
    sessionsPerDay,
  };
}
