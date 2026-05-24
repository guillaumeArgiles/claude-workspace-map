import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalOverlayProps {
  ptyId: string;
  cwd: string;
  onClose: () => void;
  onMinimize: () => void;
  /** Called when the user asks to reopen the same cwd as a fresh session. */
  onRespawn?: (cwd: string) => void;
}

/**
 * Detect the Claude Code v2.1.x crash that occurs when resuming a session
 * whose history contains a Write/Create tool result (originalFile = null).
 * Claude Code tries to call originalFile.split('\n') → TypeError.
 * Signature: Bun's /$bunfs/ path appears in the output.
 */
function isCrashOutput(chunk: string): boolean {
  return chunk.includes("/$bunfs/root/") || chunk.includes("null is not an object");
}

export function TerminalOverlay({ ptyId, cwd, onClose, onMinimize, onRespawn }: TerminalOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Always-current callbacks — the xterm key handler is set up once but needs
  // to call the latest onClose/onMinimize props without a stale closure.
  const onCloseRef = useRef(onClose);
  const onMinimizeRef = useRef(onMinimize);
  onCloseRef.current = onClose;
  onMinimizeRef.current = onMinimize;
  const [connected, setConnected] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [crashed, setCrashed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setSessionEnded(false);
    setCrashed(false);

    // ── Create terminal ─────────────────────────────────────────────────
    const term = new Terminal({
      theme: {
        background: "#0d1117",
        foreground: "#d4d4d4",
        cursor: "#6366f1",
        cursorAccent: "#0d1117",
        selectionBackground: "rgba(99, 102, 241, 0.3)",
        black: "#1e1e2e",
        red: "#f38ba8",
        green: "#a6e3a1",
        yellow: "#f9e2af",
        blue: "#89b4fa",
        magenta: "#cba6f7",
        cyan: "#89dceb",
        white: "#cdd6f4",
        brightBlack: "#585b70",
        brightRed: "#f38ba8",
        brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af",
        brightBlue: "#89b4fa",
        brightMagenta: "#cba6f7",
        brightCyan: "#89dceb",
        brightWhite: "#cdd6f4",
      },
      fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', 'Menlo', monospace",
      fontSize: 13,
      lineHeight: 1.45,
      scrollback: 5000,
      cursorBlink: true,
      cursorStyle: "bar",
      convertEol: false,
      allowProposedApi: false,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // ── Key event isolation ─────────────────────────────────────────────
    // stopPropagation prevents Phaser / sidebar shortcuts from firing while
    // the user types in the terminal. Escape is intercepted here (not sent
    // to the PTY) and closes the overlay via the always-current ref.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.key === "Escape") {
        if (ev.type === "keydown") onCloseRef.current();
        return false; // don't send ESC to the PTY
      }
      ev.stopPropagation();
      return true;
    });

    // ── Send initial dimensions to PTY ──────────────────────────────────
    const syncSize = () => {
      fit.fit();
      const { cols, rows } = term;
      fetch(`/api/sessions/${ptyId}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
    };
    syncSize();

    // ── Connect to PTY output stream ────────────────────────────────────
    const es = new EventSource(`/api/sessions/${ptyId}/output`);
    setConnected(false);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const { chunk } = JSON.parse(e.data) as { chunk: string };
        term.write(chunk);
        // Detect process exit sentinel written by pty-manager
        if (chunk.includes("[session ended]")) setSessionEnded(true);
        // Detect Claude Code crash (bug in v2.1.x: originalFile null on resume).
        // Claude prints the stack trace but does NOT exit — auto-kill after 1.5s
        // so the session ends cleanly and the recovery banner appears.
        if (isCrashOutput(chunk)) {
          setCrashed(true);
          setTimeout(() => {
            fetch(`/api/sessions/${ptyId}`, { method: "DELETE" }).catch(() => {});
          }, 1500);
        }
      } catch { /* ignore */ }
    };

    // ── Forward keyboard input to PTY ───────────────────────────────────
    term.onData((data) => {
      fetch(`/api/sessions/${ptyId}/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: data }),
      }).catch(() => {});
    });

    // ── Keep PTY size in sync with container ────────────────────────────
    const resizeObserver = new ResizeObserver(() => syncSize());
    resizeObserver.observe(container);

    term.focus();

    return () => {
      es.close();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [ptyId]);

  function handleRespawn() {
    onClose();
    onRespawn?.(cwd);
  }

  return (
    <div id="terminal-overlay">
      <div id="terminal-panel">
        <header id="terminal-header">
          <span className="term-title" title={cwd}>{shortName(cwd)}</span>
          <span className={`dot ${connected && !sessionEnded ? "ok" : "ko"}`} title={connected ? "connected" : "disconnected"} />
          <span className="term-pty-id">{ptyId.slice(0, 8)}</span>
          <div className="term-controls">
            <button className="term-btn minimize-btn" onClick={onMinimize} title="Minimize — attach to agent">—</button>
            <button className="term-btn close-btn" onClick={onClose} title="Close terminal">✕</button>
          </div>
        </header>

        <div ref={containerRef} id="terminal-xterm" />

        {/* Recovery banner — shown when Claude Code crashes loading session history */}
        {sessionEnded && crashed && onRespawn && (
          <div id="terminal-crash-bar">
            <span className="crash-msg">
              ⚠ Claude Code crashed loading session history
              <span className="crash-detail"> (bug v2.1.x — originalFile null on resume)</span>
            </span>
            <button className="crash-respawn-btn" onClick={handleRespawn}>
              ⚡ Open fresh session
            </button>
          </div>
        )}

        {/* Ended but NOT crashed — normal exit */}
        {sessionEnded && !crashed && (
          <div id="terminal-ended-bar">
            <span>Session ended</span>
            {onRespawn && (
              <button className="crash-respawn-btn" onClick={handleRespawn}>
                ⚡ New session
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function shortName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}
