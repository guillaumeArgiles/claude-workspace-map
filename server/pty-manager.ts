/**
 * PtyManager — spawns Claude Code sessions in pseudoterminals and routes
 * input/output to the HTTP layer.
 *
 * Lifecycle:
 *  1. POST /api/sessions  → PtyManager.spawn(cwd)  → returns a ptyId
 *  2. The spawned claude process writes a new JSONL file; the watcher picks it
 *     up and the agent appears on the map automatically.
 *  3. POST /api/sessions/:ptyId/write  → PtyManager.write(ptyId, text)
 *  4. GET  /api/sessions/:ptyId/output → SSE stream of raw PTY output
 *  5. DELETE /api/sessions/:ptyId      → PtyManager.kill(ptyId)
 */

import * as nodePty from "node-pty";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { child } from "./logger.js";

const log = child("pty");

/** How many bytes of terminal output to keep in the ring buffer (for reconnects). */
const OUTPUT_RING_SIZE = 32_000;

export interface PtySession {
  id: string;
  cwd: string;
  pid: number;
  /** Linked Claude session_id once detected from the JSONL watcher. */
  sessionId?: string;
  createdAt: number;
  /** Ring buffer: last N bytes of raw PTY output. */
  outputBuffer: string;
  /** Active SSE listeners — called on each new output chunk. */
  listeners: Set<(chunk: string) => void>;
  /** Resolved when the process exits. */
  exitCode?: number;
}

export class PtyManager {
  private readonly sessions = new Map<string, PtySession>();

  /**
   * Spawn `claude` (or any command) in `cwd`.
   * Returns the ptyId to use for subsequent write/output calls.
   */
  spawn(cwd: string, command = "claude"): string {
    const id = randomUUID();
    const shell = process.env.SHELL ?? "/bin/zsh";

    // Spawn the process in a PTY.
    // We use the login shell so PATH, nvm, etc. are all set up correctly.
    const pty = nodePty.spawn(shell, ["-l", "-c", command], {
      name: "xterm-256color",
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        // Prevent Claude from enabling its own full-screen TUI which would
        // make output harder to parse for the map overlay.
        CLAUDE_NO_FULLSCREEN: "1",
      } as Record<string, string>,
      cols: 220,
      rows: 50,
    });

    const session: PtySession = {
      id,
      cwd,
      pid: pty.pid,
      createdAt: Date.now(),
      outputBuffer: "",
      listeners: new Set(),
    };

    pty.onData((chunk) => {
      // Append to ring buffer, trim to size.
      session.outputBuffer += chunk;
      if (session.outputBuffer.length > OUTPUT_RING_SIZE) {
        session.outputBuffer = session.outputBuffer.slice(-OUTPUT_RING_SIZE);
      }
      // Push to all live SSE listeners.
      for (const fn of session.listeners) {
        try {
          fn(chunk);
        } catch {
          session.listeners.delete(fn);
        }
      }
    });

    pty.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      log.info({ ptyId: id, exitCode }, "PTY exited");
      // Append the sentinel to the ring buffer so clients that connect *after*
      // the process exits (e.g. fast-crashing claude --continue) still see it.
      const sentinel = "\r\n[session ended]\r\n";
      session.outputBuffer += sentinel;
      if (session.outputBuffer.length > OUTPUT_RING_SIZE) {
        session.outputBuffer = session.outputBuffer.slice(-OUTPUT_RING_SIZE);
      }
      // Notify already-connected listeners.
      for (const fn of session.listeners) {
        try {
          fn(sentinel);
        } catch {
          /* ignore */
        }
      }
      session.listeners.clear();
      // Keep session in map for a bit so the UI can read the exit code.
      setTimeout(() => this.sessions.delete(id), 60_000);
    });

    this.sessions.set(id, session);
    log.info({ ptyId: id, cwd, pid: pty.pid }, "PTY spawned");

    // Attach the pty instance so we can write/kill it.
    (session as PtySession & { _pty: nodePty.IPty })._pty = pty;

    return id;
  }

  /**
   * Send raw data to a PTY.
   * Passes bytes through as-is — callers (xterm.js onData) already include
   * the correct terminal sequences (\r for Enter, \x03 for Ctrl+C, etc.).
   */
  write(ptyId: string, text: string): boolean {
    const s = this.sessions.get(ptyId) as (PtySession & { _pty?: nodePty.IPty }) | undefined;
    if (!s?._pty) return false;
    s._pty.write(text);
    return true;
  }

  /** Send a single key / escape sequence to a PTY. */
  sendKey(ptyId: string, key: string): boolean {
    return this.write(ptyId, key);
  }

  /**
   * Resize a PTY to match the xterm.js terminal dimensions.
   * Must be called after FitAddon.fit() to keep PTY and UI in sync.
   */
  resize(ptyId: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(ptyId) as (PtySession & { _pty?: nodePty.IPty }) | undefined;
    if (!s?._pty) return false;
    try {
      s._pty.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      /* ignore resize errors on exited PTYs */
    }
    return true;
  }

  /** Kill the underlying process. */
  kill(ptyId: string): boolean {
    const s = this.sessions.get(ptyId) as (PtySession & { _pty?: nodePty.IPty }) | undefined;
    if (!s?._pty) return false;
    try {
      s._pty.kill();
    } catch {
      /* already dead */
    }
    return true;
  }

  /** Link a Claude session_id to a pty (called by the watcher when a new JSONL appears). */
  linkSession(ptyId: string, sessionId: string): void {
    const s = this.sessions.get(ptyId);
    if (s) s.sessionId = sessionId;
  }

  get(ptyId: string): PtySession | undefined {
    return this.sessions.get(ptyId);
  }

  list(): PtySession[] {
    return [...this.sessions.values()];
  }

  get homeDir(): string {
    return os.homedir();
  }
}

export const ptyManager = new PtyManager();
