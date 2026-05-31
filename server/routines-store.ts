/**
 * On-disk store for FleetView routines.
 *
 * Single JSON file under ~/.claude-workspace-map/routines.json. Reads
 * tolerate missing/corrupt files (returns defaults); writes go through
 * a tmp-file + rename for atomicity so a crash mid-write can't leave
 * the user with a half-written index.
 *
 * Everything is async and Zod-validated on both read and write — the
 * file is hand-editable, so we treat the disk as untrusted input.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_ROUTINES_FILE,
  RoutineSchema,
  RoutinesFileSchema,
  type Routine,
  type RoutinesFile,
} from "../shared/routine-schema.js";
import { child } from "./logger.js";

const log = child("routines-store");

const ROUTINES_DIR = path.join(os.homedir(), ".claude-workspace-map");
const ROUTINES_PATH = path.join(ROUTINES_DIR, "routines.json");

// ── Read / write helpers ─────────────────────────────────────────────────────

export async function readRoutinesFile(): Promise<RoutinesFile> {
  try {
    const raw = await fs.readFile(ROUTINES_PATH, "utf8");
    return RoutinesFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    // Missing file → first launch, return defaults silently.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_ROUTINES_FILE };
    }
    // Corrupted JSON or schema mismatch → log and recover. Don't crash the
    // server because a hand-edit went sideways.
    log.warn({ err }, "routines.json invalid, falling back to empty store");
    return { ...DEFAULT_ROUTINES_FILE };
  }
}

async function writeRoutinesFile(file: RoutinesFile): Promise<void> {
  const validated = RoutinesFileSchema.parse(file);
  await fs.mkdir(ROUTINES_DIR, { recursive: true });
  const tmp = `${ROUTINES_PATH}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(validated, null, 2), "utf8");
  await fs.rename(tmp, ROUTINES_PATH);
}

// ── Public CRUD API ──────────────────────────────────────────────────────────

export async function listRoutines(): Promise<Routine[]> {
  const file = await readRoutinesFile();
  return file.routines;
}

export async function getRoutine(id: string): Promise<Routine | undefined> {
  const file = await readRoutinesFile();
  return file.routines.find((r) => r.id === id);
}

export interface CreateRoutineInput {
  name: string;
  cronExpression: string;
  prompt: string;
  cwd?: string;
  enabled?: boolean;
}

/**
 * Create a routine with a fresh kebab-case id derived from the name.
 * Collisions resolved with a short random suffix.
 */
export async function createRoutine(input: CreateRoutineInput): Promise<Routine> {
  const file = await readRoutinesFile();
  const baseId = slugify(input.name);
  const id = file.routines.some((r) => r.id === baseId)
    ? `${baseId}-${randomUUID().slice(0, 6)}`
    : baseId;

  const routine: Routine = RoutineSchema.parse({
    id,
    name: input.name,
    cronExpression: input.cronExpression,
    prompt: input.prompt,
    cwd: input.cwd,
    enabled: input.enabled ?? true,
    createdAt: Date.now(),
  });

  await writeRoutinesFile({ ...file, routines: [...file.routines, routine] });
  return routine;
}

export interface UpdateRoutineInput {
  name?: string;
  cronExpression?: string;
  prompt?: string;
  cwd?: string;
  enabled?: boolean;
}

export async function updateRoutine(
  id: string,
  patch: UpdateRoutineInput
): Promise<Routine | undefined> {
  const file = await readRoutinesFile();
  const idx = file.routines.findIndex((r) => r.id === id);
  if (idx < 0) return undefined;
  const merged = RoutineSchema.parse({ ...file.routines[idx], ...patch });
  const next = [...file.routines];
  next[idx] = merged;
  await writeRoutinesFile({ ...file, routines: next });
  return merged;
}

/**
 * Internal: stamp a run result (lastRunAt + status + ptyId). Used by the
 * scheduler when a routine fires.
 */
export async function recordRoutineRun(
  id: string,
  patch: { lastRunAt: number; lastRunStatus: Routine["lastRunStatus"]; lastRunPtyId?: string }
): Promise<void> {
  await updateRoutine(id, patch as UpdateRoutineInput);
}

export async function deleteRoutine(id: string): Promise<boolean> {
  const file = await readRoutinesFile();
  const next = file.routines.filter((r) => r.id !== id);
  if (next.length === file.routines.length) return false;
  await writeRoutinesFile({ ...file, routines: next });
  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** kebab-case-ify a free-form name. Strips diacritics, lowercases, dedupes -. */
function slugify(input: string): string {
  const ascii = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // The schema regex requires a non-hyphen start. Fallback to a generic
  // prefix if the input boils down to nothing.
  return slug && /^[a-z0-9]/.test(slug) ? slug : `routine-${randomUUID().slice(0, 6)}`;
}

/** Exposed for the scheduler / tests; resolves to ~/.claude-workspace-map. */
export const ROUTINES_BASE_DIR = ROUTINES_DIR;
