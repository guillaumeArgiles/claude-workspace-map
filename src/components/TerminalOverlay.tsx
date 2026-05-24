import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalOverlayProps {
  ptyId: string;
  cwd: string;
  onClose: () => void;
}

export function TerminalOverlay({ ptyId, cwd, onClose }: TerminalOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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
      fontSize: 12,
      lineHeight: 1.4,
      scrollback: 5000,
      cursorBlink: true,
      cursorStyle: "bar",
      convertEol: false, // raw pass-through, PTY handles EOL
      allowProposedApi: false,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // ── Key event isolation ─────────────────────────────────────────────
    // Phaser's KeyboardPlugin listens on `window` and calls preventDefault()
    // on captured keys (space, arrows…). xterm.js checks defaultPrevented
    // before processing, so those keys silently vanish.
    // Fix: intercept every keydown/keyup on the xterm canvas before the event
    // bubbles up to Phaser, and stop propagation there.
    // We let Escape through (return false = xterm ignores it) so the overlay
    // div's own handler can close the panel.
    term.attachCustomKeyEventHandler((ev) => {
      ev.stopPropagation(); // never reaches Phaser's window listener
      if (ev.key === "Escape" && ev.type === "keydown") {
        return false;       // xterm ignores Escape → overlay div catches it
      }
      return true;          // xterm handles everything else normally
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
      } catch {
        /* ignore malformed frames */
      }
    };

    // ── Forward keyboard input to PTY ───────────────────────────────────
    // xterm onData fires for every key sequence including arrows, Ctrl+C,
    // UTF-8 chars, paste — exactly what the PTY expects, no processing needed.
    term.onData((data) => {
      fetch(`/api/sessions/${ptyId}/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: data }),
      }).catch(() => {});
    });

    // ── Resize observer — keep PTY in sync with container ───────────────
    const resizeObserver = new ResizeObserver(() => syncSize());
    resizeObserver.observe(container);

    // Focus so keystrokes reach xterm immediately
    term.focus();

    return () => {
      es.close();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [ptyId]);

  return (
    // onKeyDown catches Escape that xterm let through (returned false above)
    <div id="terminal-overlay" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div id="terminal-panel">
        <header id="terminal-header">
          <span className="term-title" title={cwd}>
            {shortName(cwd)}
          </span>
          <span
            className={`dot ${connected ? "ok" : "ko"}`}
            title={connected ? "connected" : "disconnected"}
          />
          <span className="term-pty-id">{ptyId.slice(0, 8)}</span>
          <button className="close-btn" onClick={onClose} title="Close terminal (Esc)">
            ✕
          </button>
        </header>

        {/* xterm.js mounts here — it creates its own canvas */}
        <div ref={containerRef} id="terminal-xterm" />
      </div>
    </div>
  );
}

function shortName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}
