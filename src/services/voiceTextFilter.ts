/**
 * Streaming filter that turns raw Claude Code PTY output into something
 * suitable for Text-To-Speech.
 *
 * The PTY stream mixes :
 *   1. The Professor's actual prose responses (what we want to speak)
 *   2. Claude Code's TUI chrome (box drawings, status lines, prompts)
 *   3. Tool calls and their outputs (JSON, file paths, command echoes)
 *   4. ANSI escape codes (cursor positioning, colours)
 *   5. The user's typed input, echoed back by the terminal
 *
 * We strip (4) eagerly via {@link stripAnsi}, then accumulate the remaining
 * text line by line. For each complete line we apply heuristics that
 * recognise (2)/(3)/(5) and drop them. Code fences (\`\`\`...\`\`\`) are
 * tracked across lines as a stateful skip-region.
 *
 * The class is **stateful** on purpose : a chunk can arrive mid-line, and
 * we need to track whether we're inside a code block. Callers should keep
 * one instance per PTY attach and discard it when the stream closes.
 */

export class VoiceTextFilter {
  /** Buffer holding the trailing partial line until a newline arrives. */
  private pending = "";
  /** Are we currently inside a code fence ? */
  private inCodeBlock = false;

  /**
   * Feed a raw PTY chunk. Returns the speakable portion (may be empty when
   * the chunk only contained chrome / code / control characters).
   */
  feed(chunk: string): string {
    const text = stripAnsi(chunk);
    if (!text) return "";

    this.pending += text;
    // Split on any newline. We keep the trailing partial line for next feed.
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";

    const speakable: string[] = [];
    for (const line of lines) {
      const out = this.processLine(line);
      if (out) speakable.push(out);
    }
    return speakable.join(" ");
  }

  /**
   * Decide whether `line` (a complete line, ANSI-free) is speakable. Returns
   * the cleaned text if yes, null if it's chrome / code / a path / etc.
   */
  private processLine(rawLine: string): string | null {
    const line = rawLine.trim();
    if (!line) return null;

    // Code fence toggle — never speak the fence itself or the contents.
    if (line.startsWith("```")) {
      this.inCodeBlock = !this.inCodeBlock;
      return null;
    }
    if (this.inCodeBlock) return null;

    // Pure box-drawing / separator lines (Claude Code's TUI uses ─│┌┐└┘├┤┬┴┼ widely).
    if (/^[\s─│┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋═║╔╗╚╝╠╣╦╩╬·*=+\-_·]+$/u.test(line)) return null;

    // Standalone status markers / bullet characters that Claude Code emits
    // (✓, ✗, ●, ▸, ⏺, etc.) — strip them when they're the start of an
    // otherwise-empty visual indicator line.
    if (/^[✓✗●▸⏺❯>►·•∙\s]+$/u.test(line)) return null;

    // Lines that look exclusively like a file path : start with / or ~,
    // contain a dot extension, no spaces (path-only). We don't want to
    // hear "slash users slash gargiles slash dot claude slash …".
    if (/^[~/][^\s]+\.[A-Za-z0-9]{1,8}$/u.test(line)) return null;
    // Same for relative paths with no spaces and an extension.
    if (/^\.{1,2}\/[^\s]+\.[A-Za-z0-9]{1,8}$/u.test(line)) return null;

    // Lines that are clearly URLs only (no surrounding prose).
    if (/^https?:\/\/\S+$/.test(line)) return null;

    // Claude Code prompt echoes : "> " prefix when the user typed something
    // that's being shown back. Best-effort — we drop the visible echo.
    if (/^>\s/.test(line)) return null;

    // Tool indicators ("⏺ list_agents()" or "● Read") — single line,
    // mostly tool-name + small detail. We could keep the prose part, but
    // the simpler rule is to drop these since the Professor is told to
    // synthesise rather than report tool calls.
    if (/^[⏺●▸]\s+[A-Za-z_][\w()]*/u.test(line)) return null;

    // Otherwise : speakable prose, but strip any leading / trailing box
    // drawing chars that sit on the edges of a TUI panel row.
    return line.replace(/^[\s─│┌┐└┘├┤┬┴┼━┃═║·*=]+|[\s─│┌┐└┘├┤┬┴┼━┃═║·*=]+$/gu, "") || null;
  }

  /** Reset internal buffers — call when the PTY attach changes. */
  reset(): void {
    this.pending = "";
    this.inCodeBlock = false;
  }
}

// ── ANSI stripping ───────────────────────────────────────────────────────────

/**
 * Removes the ANSI escape sequences emitted by Claude Code's TUI so the
 * resulting text reads naturally to a TTS engine.
 *
 * Covers : CSI, OSC, ESC-prefixed two-char sequences, lone control chars.
 * Tighter than `strip-ansi` npm for this specific use case.
 */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?<>= ]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[>=]/g, "")
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "");
}
