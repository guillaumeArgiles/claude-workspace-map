import { useEffect, useRef, useState } from "react";

interface TerminalOverlayProps {
  ptyId: string;
  cwd: string;
  onClose: () => void;
}

// Strip the most common ANSI/VT100 escape sequences so raw PTY output is
// readable in the overlay without a full terminal emulator.
function stripAnsi(s: string): string {
  return (
    s
      // CSI sequences: ESC [ ... final-byte
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      // OSC sequences: ESC ] ... ST
      .replace(/\x1b\][^]*?(?:\x07|\x1b\\)/g, "")
      // Other ESC sequences (2-char)
      .replace(/\x1b[^[]/g, "")
      // Normalize carriage returns
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
  );
}

const MAX_OUTPUT = 60_000; // ~60 KB

export function TerminalOverlay({ ptyId, cwd, onClose }: TerminalOverlayProps) {
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Connect to SSE output stream for this PTY session.
  useEffect(() => {
    setOutput("");
    setConnected(false);

    const es = new EventSource(`/api/sessions/${ptyId}/output`);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const { chunk } = JSON.parse(e.data) as { chunk: string };
        setOutput((prev) => {
          const next = prev + chunk;
          return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next;
        });
      } catch {
        /* ignore malformed frames */
      }
    };

    return () => es.close();
  }, [ptyId]);

  // Auto-scroll to bottom whenever output grows.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  // Focus input after mount.
  useEffect(() => inputRef.current?.focus(), []);

  async function sendText(text: string) {
    if (!text) return;
    setSending(true);
    try {
      await fetch(`/api/sessions/${ptyId}/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = input;
      setInput("");
      sendText(text);
    } else if (e.key === "Escape") {
      onClose();
    } else if (e.key === "c" && e.ctrlKey) {
      // Ctrl+C — interrupt
      e.preventDefault();
      sendText("\x03");
    }
  }

  const cleanOutput = stripAnsi(output);

  return (
    <div id="terminal-overlay">
      <div id="terminal-panel">
        <header id="terminal-header">
          <span className="term-title" title={cwd}>
            {shortName(cwd)}
          </span>
          <span className={`dot ${connected ? "ok" : "ko"}`} title={connected ? "connected" : "disconnected"} />
          <span className="term-pty-id">{ptyId.slice(0, 8)}</span>
          <button className="close-btn" onClick={onClose} title="Close terminal">
            ✕
          </button>
        </header>

        <pre ref={outputRef} id="terminal-output">
          {cleanOutput || <span className="term-empty">Waiting for output…</span>}
        </pre>

        <div id="terminal-input-row">
          <span className="term-prompt">›</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message… (Enter to send, Ctrl+C to interrupt)"
            disabled={sending}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            className="term-send-btn"
            onClick={() => { const t = input; setInput(""); sendText(t); }}
            disabled={!input.trim() || sending}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function shortName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}
