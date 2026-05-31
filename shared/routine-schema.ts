/**
 * FleetView routine schema — recurring jobs scheduled and executed by
 * FleetView itself (independent of Claude Code / Claude Desktop's own
 * scheduled-tasks systems, which we also read-only mirror separately).
 *
 * A routine fires periodically according to its cron expression, spawning
 * a fresh Claude session via the existing PTY manager with the given prompt.
 * State persists across restarts in ~/.claude-workspace-map/routines.json.
 *
 * Cron expressions are 5-field, evaluated in the user's LOCAL timezone
 * (matching Claude Code's convention).
 */

import { z } from "zod";

/** Statuses for the most recent run — kept compact for the index. */
export const RoutineRunStatus = z.enum(["pending", "running", "success", "error"]);
export type RoutineRunStatus = z.infer<typeof RoutineRunStatus>;

/**
 * A user-defined FleetView routine. `id` is a kebab-case slug auto-derived
 * from `name` at creation (collisions resolved with a numeric suffix).
 */
export const RoutineSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(120),
  cronExpression: z.string().min(1),
  prompt: z.string().min(1),
  /** Optional working directory for the spawned Claude session.
   *  Falls back to a dedicated routines dir under ~/.claude-workspace-map/ */
  cwd: z.string().optional(),
  /** When false, the routine stays in the store but never fires. */
  enabled: z.boolean().default(true),
  createdAt: z.number().int().positive(),
  lastRunAt: z.number().int().positive().optional(),
  lastRunStatus: RoutineRunStatus.optional(),
  lastRunPtyId: z.string().optional(),
});
export type Routine = z.infer<typeof RoutineSchema>;

/** Full file shape. Keep it future-proof by stashing version + entries. */
export const RoutinesFileSchema = z.object({
  version: z.literal(1).default(1),
  routines: z.array(RoutineSchema).default([]),
});
export type RoutinesFile = z.infer<typeof RoutinesFileSchema>;

export const DEFAULT_ROUTINES_FILE: RoutinesFile = { version: 1, routines: [] };

/**
 * Native (read-only) routine summary — what we expose from Claude Code's
 * own scheduled-tasks systems. We don't claim to support editing these;
 * they're shown alongside FleetView routines for context.
 */
export const NativeRoutineSchema = z.object({
  /** Where on disk we read this from — lets the UI group entries by source. */
  source: z.enum(["claude-code-mcp", "claude-desktop", "claude-code-sessions"]),
  /** Stable id (taskId / dir name / json key). */
  id: z.string(),
  /** Human-readable name; usually pulled from frontmatter or filename. */
  name: z.string(),
  description: z.string().optional(),
  cronExpression: z.string().optional(),
  enabled: z.boolean().optional(),
  lastRunAt: z.number().int().positive().optional(),
  /** First ~200 chars of the prompt/SKILL.md body — preview only. */
  promptPreview: z.string().optional(),
  /** Absolute path to the underlying file — useful for power users. */
  filePath: z.string().optional(),
});
export type NativeRoutine = z.infer<typeof NativeRoutineSchema>;

/** Common cron presets surfaced in the UI. Always offer "custom" alongside. */
export const CRON_PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Tous les jours à 9h", value: "0 9 * * *" },
  { label: "Tous les jours à 18h", value: "0 18 * * *" },
  { label: "Jours ouvrés à 9h", value: "0 9 * * 1-5" },
  { label: "Chaque lundi à 9h", value: "0 9 * * 1" },
  { label: "Chaque heure pile", value: "0 * * * *" },
  { label: "Premier du mois à minuit", value: "0 0 1 * *" },
];
