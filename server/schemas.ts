/**
 * Zod schemas for the JSONL lines emitted by Claude Code into
 * `~/.claude/projects/**\/*.jsonl`.
 *
 * These describe *just enough* of the shape we actually read in `parser.ts` —
 * the JSONL format is large and we ignore most of it (e.g. token usage,
 * model metadata, attachments). Unknown fields pass through Zod's default
 * "strip" mode without erroring.
 *
 * Validation failures are not fatal: callers log them as telemetry so we
 * notice when Claude Code's format drifts under us (the #1 long-term risk
 * called out in ADR 0001).
 */

import { z } from "zod";

/** A `tool_use` block in an assistant message. */
export const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
});

/** A `text` block in an assistant message. */
export const TextBlockSchema = z.object({
  type: z.literal("text"),
});

/** A `tool_result` block in a user message (the reply to a tool_use). */
export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().optional(),
});

/** Fallback for any block type we don't specifically care about (image, thinking, …). */
export const UnknownBlockSchema = z.object({
  type: z.string(),
});

/**
 * Discriminated on `type` so consumers get narrow types after a check
 * (e.g. `if (block.type === "tool_use") block.id` is statically resolved).
 * Falls back to UnknownBlock for types we don't care about.
 */
export const ContentBlockSchema = z.union([
  ToolUseBlockSchema,
  TextBlockSchema,
  ToolResultBlockSchema,
  UnknownBlockSchema,
]);

/** Narrow helpers — work around the lack of automatic narrowing on z.union. */
export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}
export function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
  return b.type === "tool_result";
}

export const MessageSchema = z.object({
  content: z.array(ContentBlockSchema).optional(),
});

/**
 * Top-level JSONL line shape — only the fields `parser.ts` reads. Both
 * `assistant` and `user` lines wrap their payload in `message.content`;
 * `system` lines use `subtype` and sometimes set `message` to a bare string.
 *
 * `message` is intentionally typed as `unknown` here: its shape varies by
 * line type, so we validate it on-demand with MessageSchema where it matters.
 */
export const JsonlLineSchema = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  isSidechain: z.boolean().optional(),
  cwd: z.string().optional(),
  subtype: z.string().optional(),
  message: z.unknown().optional(),
});

export type JsonlLine = z.infer<typeof JsonlLineSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
