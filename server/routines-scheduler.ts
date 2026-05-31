/**
 * FleetView routines scheduler.
 *
 * Polls the store every {@link TICK_MS} and fires any routine whose next
 * cron occurrence falls between its last run (or its createdAt) and now.
 * Firing = spawn a Claude session via the PTY manager and inject the
 * prompt followed by `\r`, mirroring the Professor's bootstrap pattern.
 *
 * Cron is evaluated in the user's LOCAL timezone (cron-parser default),
 * matching the convention used by Claude Code's native scheduled tasks.
 *
 * The scheduler only fires while FleetView is running. If the app is
 * closed when a cron tick should have happened, the routine simply
 * skips that occurrence and waits for the next — this matches how
 * Claude's own native scheduler handles app-closed windows.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { CronExpressionParser } from "cron-parser";
import { ptyManager } from "./pty-manager.js";
import {
  listRoutines,
  recordRoutineRun,
  ROUTINES_BASE_DIR,
} from "./routines-store.js";
import { child } from "./logger.js";
import type { Routine } from "../shared/routine-schema.js";

const log = child("routines-scheduler");

/** Poll cadence. 30s = good enough resolution for human-scale schedules. */
const TICK_MS = 30_000;

/** Delay before pushing the prompt into the fresh PTY (Claude boot warm-up). */
const PROMPT_BOOT_DELAY_MS = 1500;

/**
 * Default working directory for a routine that didn't specify one. We use a
 * dedicated per-routine dir under ~/.claude-workspace-map/routines/<id>/ so
 * each routine has its own Claude project context (separate JSONL transcript,
 * separate cwd-based grouping in the map).
 */
function defaultCwdFor(routineId: string): string {
  return path.join(ROUTINES_BASE_DIR, "routines", routineId);
}

/** Wraps cron-parser with the convention used everywhere in this module. */
function parseExpression(expr: string) {
  return CronExpressionParser.parse(expr, { tz: undefined /* local */ });
}

/**
 * Decide whether the routine should fire NOW. True iff the next cron
 * occurrence after `lastRunAt` (or `createdAt`) is in the past.
 *
 * Returns `false` (without logging) for invalid cron expressions — we tolerate
 * a stale routine left over from a downgrade rather than crash the scheduler.
 */
function shouldFire(routine: Routine, now: number): boolean {
  if (!routine.enabled) return false;
  const baseline = routine.lastRunAt ?? routine.createdAt;
  try {
    const iter = parseExpression(routine.cronExpression);
    iter.reset(new Date(baseline));
    const nextOccurrence = iter.next().toDate().getTime();
    return nextOccurrence <= now;
  } catch (err) {
    log.warn({ err, routineId: routine.id, cron: routine.cronExpression }, "invalid cron, skipping");
    return false;
  }
}

/**
 * Compute the next firing date for display purposes. Returns null on
 * invalid cron — UI shows a "—" in that case.
 */
export function nextRunAtFor(routine: Routine): number | null {
  try {
    const iter = parseExpression(routine.cronExpression);
    return iter.next().toDate().getTime();
  } catch {
    return null;
  }
}

/**
 * Fire a single routine: ensure the cwd exists, spawn the PTY, queue the
 * prompt after the boot delay, and stamp the lastRunAt/Status.
 */
async function fireRoutine(routine: Routine): Promise<void> {
  const cwd = routine.cwd ?? defaultCwdFor(routine.id);
  try {
    await fs.mkdir(cwd, { recursive: true });
  } catch (err) {
    log.warn({ err, routineId: routine.id, cwd }, "couldn't ensure routine cwd");
  }

  let ptyId: string;
  try {
    ptyId = ptyManager.spawn(cwd);
  } catch (err) {
    log.warn({ err, routineId: routine.id }, "routine spawn failed");
    await recordRoutineRun(routine.id, {
      lastRunAt: Date.now(),
      lastRunStatus: "error",
    });
    return;
  }

  await recordRoutineRun(routine.id, {
    lastRunAt: Date.now(),
    lastRunStatus: "running",
    lastRunPtyId: ptyId,
  });

  // Queue the prompt after Claude has booted in the PTY. We don't await this
  // — the scheduler tick stays snappy, and run status moves to "success"
  // once the prompt is in.
  setTimeout(() => {
    const ok = ptyManager.write(ptyId, `${routine.prompt}\r`);
    void recordRoutineRun(routine.id, {
      lastRunAt: Date.now(),
      lastRunStatus: ok ? "success" : "error",
      lastRunPtyId: ptyId,
    });
    log.info({ routineId: routine.id, ptyId, ok }, "routine fired");
  }, PROMPT_BOOT_DELAY_MS);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  const now = Date.now();
  let routines: Routine[];
  try {
    routines = await listRoutines();
  } catch (err) {
    log.warn({ err }, "tick — couldn't read routines store");
    return;
  }
  for (const r of routines) {
    if (shouldFire(r, now)) {
      log.info({ routineId: r.id, cron: r.cronExpression }, "firing routine");
      await fireRoutine(r);
    }
  }
}

/**
 * Start the periodic poll. Idempotent — safe to call from the server boot
 * even when hot-reloading.
 */
export function startRoutinesScheduler(): void {
  if (timer) return;
  // Initial run after a short delay so the server has time to settle.
  timer = setTimeout(function loop() {
    void tick().finally(() => {
      timer = setTimeout(loop, TICK_MS);
    });
  }, 2_000);
  log.info({ tickMs: TICK_MS }, "routines scheduler started");
}

export function stopRoutinesScheduler(): void {
  if (!timer) return;
  clearTimeout(timer);
  timer = undefined;
  log.info("routines scheduler stopped");
}
