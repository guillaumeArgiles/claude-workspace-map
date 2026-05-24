import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentState,
  ServerEvent,
  SubAgentState,
} from "../../shared/agent-types";
import {
  teacherSpriteFor,
  studentSpriteFor,
} from "../../shared/agent-sprites";
import { STATUS_COLOR, STATUS_LABEL, statusOrder } from "../../shared/agent-ui";
import { SpawnPanel } from "./SpawnPanel";
import { TerminalOverlay } from "./TerminalOverlay";

// ── PTY session state ───────────────────────────────────────────────────────
export interface ActivePty {
  ptyId: string;
  cwd: string;
  minimized: boolean;
}

// ── localStorage helpers ────────────────────────────────────────────────────
function loadRecentCwds(): string[] {
  try {
    return JSON.parse(localStorage.getItem("recentCwds") ?? "[]") as string[];
  } catch {
    return [];
  }
}
function saveRecentCwds(cwds: string[]) {
  try { localStorage.setItem("recentCwds", JSON.stringify(cwds)); } catch { /* ignore */ }
}

// ── Sprite helper ───────────────────────────────────────────────────────────
function spriteStyle(spriteName: string): React.CSSProperties {
  return {
    backgroundImage: `url(/assets/sprites/${spriteName}.png)`,
    backgroundPosition: "-32px 0px",
    backgroundSize: "96px 128px",
    width: 32,
    height: 32,
    imageRendering: "pixelated",
  };
}

// ── Props ───────────────────────────────────────────────────────────────────
interface AgentSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

// ── Component ───────────────────────────────────────────────────────────────
export function AgentSidebar({ collapsed, onToggle }: AgentSidebarProps) {
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [connected, setConnected] = useState(false);
  const [ptySessions, setPtySessions] = useState<ActivePty[]>([]);
  const [showSpawnPanel, setShowSpawnPanel] = useState(false);
  const [spawnDefaultCwd, setSpawnDefaultCwd] = useState("");
  const [recentCwds, setRecentCwds] = useState<string[]>(loadRecentCwds);
  /** sessionId being resumed right now (shows spinner in that row). */
  const [resumingId, setResumingId] = useState<string | null>(null);

  // ── Chat state ─────────────────────────────────────────────────────────────
  /** sessionId whose chat input is open. */
  const [chatOpenId, setChatOpenId] = useState<string | null>(null);
  /** Current draft text (shared — only one chat open at a time). */
  const [chatDraft, setChatDraft] = useState("");
  /** sessionId currently being sent (shows spinner). */
  const [chatSendingId, setChatSendingId] = useState<string | null>(null);
  /** sessionId waiting for first response chunk after a send. */
  const [chatAwaitingId, setChatAwaitingId] = useState<string | null>(null);
  /** Accumulated ANSI-stripped PTY output per sessionId. */
  const [chatOutputs, setChatOutputs] = useState<Map<string, string>>(new Map());
  /** Active PTY output SSE connections (keyed by sessionId). */
  const chatEsRef = useRef<Map<string, EventSource>>(new Map());

  // ── SSE subscription ──────────────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource("/api/events");
    const byId = new Map<string, AgentState>();
    const flush = () => setAgents(Array.from(byId.values()));

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      let ev: ServerEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      switch (ev.type) {
        case "snapshot":
          byId.clear();
          for (const a of ev.agents) byId.set(a.sessionId, a);
          break;
        case "agent_spawned":
        case "agent_updated":
          byId.set(ev.agent.sessionId, ev.agent);
          break;
        case "agent_removed":
          byId.delete(ev.sessionId);
          break;
      }
      flush();
    };
    return () => es.close();
  }, []);

  // ── PTY session management ────────────────────────────────────────────────
  /** Spawn a brand-new Claude session (no --continue / --resume) in cwd. */
  async function spawnFresh(cwd: string) {
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { ptyId } = (await res.json()) as { ptyId: string };
      handleSpawned({ ptyId, cwd, spawnedAt: Date.now() });
    } catch (err) {
      console.error("Failed to spawn fresh session:", err);
    }
  }

  function handleSpawned(session: { ptyId: string; cwd: string; spawnedAt: number }) {
    setRecentCwds((prev) => {
      const next = [session.cwd, ...prev.filter((c) => c !== session.cwd)].slice(0, 10);
      saveRecentCwds(next);
      return next;
    });
    setPtySessions((prev) => [
      ...prev.filter((p) => p.ptyId !== session.ptyId),
      { ptyId: session.ptyId, cwd: session.cwd, minimized: false },
    ]);
  }

  function minimizeTerminal(ptyId: string) {
    setPtySessions((prev) => prev.map((p) => p.ptyId === ptyId ? { ...p, minimized: true } : p));
  }

  function restoreTerminal(ptyId: string) {
    setPtySessions((prev) => prev.map((p) => p.ptyId === ptyId ? { ...p, minimized: false } : p));
  }

  function closeTerminal(ptyId: string) {
    setPtySessions((prev) => prev.filter((p) => p.ptyId !== ptyId));
    // Kill the underlying PTY process (no-op if already dead).
    fetch(`/api/sessions/${ptyId}`, { method: "DELETE" }).catch(() => {});
  }

  /**
   * Resume an existing agent session in a new PTY.
   *
   * We use `claude --continue` (not `--resume <sessionId>`).
   * `--resume <UUID>` triggers a git-diff crash in Claude Code's Bun
   * runtime for non-recent sessions (unhandled exception in the diff
   * stats initializer). `--continue` loads the most recent conversation
   * in the cwd — same net result, no crash.
   */
  async function resumeSession(agent: AgentState) {
    if (resumingId) return; // debounce
    setResumingId(agent.sessionId);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: agent.cwd,
          command: "claude --continue",
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { ptyId } = (await res.json()) as { ptyId: string };
      handleSpawned({ ptyId, cwd: agent.cwd, spawnedAt: Date.now() });
    } catch (err) {
      console.error("Failed to resume session:", err);
    } finally {
      setResumingId(null);
    }
  }

  /** Called when user clicks an agent row. */
  function handleAgentClick(agent: AgentState) {
    const pty = ptySessions.find((p) => p.cwd === agent.cwd);
    if (pty) {
      restoreTerminal(pty.ptyId);
    } else {
      void resumeSession(agent);
    }
  }

  // ── Cleanup SSE on unmount ────────────────────────────────────────────────
  useEffect(() => {
    const ref = chatEsRef.current;
    return () => { for (const es of ref.values()) es.close(); ref.clear(); };
  }, []);

  // ── Chat helpers ──────────────────────────────────────────────────────────

  /** Strip ANSI escape sequences from raw PTY output. */
  function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s
      .replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[()][A-B])/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
  }

  /** Start streaming PTY output into chatOutputs for `sessionId`. Idempotent. */
  function startOutputSub(sessionId: string, ptyId: string) {
    if (chatEsRef.current.has(sessionId)) return;
    const es = new EventSource(`/api/sessions/${ptyId}/output`);
    es.onmessage = (e) => {
      try {
        const { chunk } = JSON.parse(e.data) as { chunk: string };
        const text = stripAnsi(chunk);
        if (!text) return;
        // Clear "thinking" indicator on first meaningful output.
        setChatAwaitingId((prev) => (prev === sessionId ? null : prev));
        setChatOutputs((prev) => {
          const next = new Map(prev);
          const existing = next.get(sessionId) ?? "";
          const combined = existing + text;
          // Keep last 8 KB to avoid unbounded growth.
          next.set(sessionId, combined.length > 8192 ? combined.slice(-8192) : combined);
          return next;
        });
      } catch { /* ignore parse errors */ }
    };
    chatEsRef.current.set(sessionId, es);
  }

  /** Stop and clean up PTY output subscription for `sessionId`. */
  function stopOutputSub(sessionId: string) {
    const es = chatEsRef.current.get(sessionId);
    if (es) { es.close(); chatEsRef.current.delete(sessionId); }
  }

  /**
   * Ensure a background PTY exists for `cwd`.
   * If one already exists (visible or minimized), reuse it.
   * Otherwise spawn `claude --continue` minimised (no terminal overlay).
   * Returns the ptyId, or null on failure.
   */
  async function ensurePty(cwd: string): Promise<string | null> {
    const existing = ptySessions.find((p) => p.cwd === cwd);
    if (existing) return existing.ptyId;
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, command: "claude --continue" }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { ptyId } = (await res.json()) as { ptyId: string };
      // Track it as a minimised session — no terminal overlay until user asks.
      setRecentCwds((prev) => {
        const next = [cwd, ...prev.filter((c) => c !== cwd)].slice(0, 10);
        saveRecentCwds(next);
        return next;
      });
      setPtySessions((prev) => [
        ...prev.filter((p) => p.cwd !== cwd),
        { ptyId, cwd, minimized: true },
      ]);
      return ptyId;
    } catch (err) {
      console.error("Failed to ensure PTY for chat:", err);
      return null;
    }
  }

  /** Send a freeform message to the agent running in `cwd`. */
  async function sendChatMessage(agent: AgentState, message: string) {
    const text = message.trim();
    if (!text || chatSendingId) return;

    setChatSendingId(agent.sessionId);
    try {
      const ptyId = await ensurePty(agent.cwd);
      if (!ptyId) return;
      // Ensure output subscription is active (in case toggleChat's async call
      // hasn't resolved yet).
      startOutputSub(agent.sessionId, ptyId);
      // Show "thinking" indicator until first response chunk arrives.
      setChatAwaitingId(agent.sessionId);

      await fetch(`/api/sessions/${ptyId}/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text + "\r" }),
      });
      setChatDraft("");
      // Keep chat open for follow-up messages.
    } catch (err) {
      console.error("Chat send failed:", err);
    } finally {
      setChatSendingId(null);
    }
  }

  /** Toggle the chat input for a given session. */
  function toggleChat(sessionId: string, agent: AgentState) {
    if (chatOpenId === sessionId) {
      setChatOpenId(null);
      setChatDraft("");
      setChatAwaitingId(null);
      stopOutputSub(sessionId);
    } else {
      setChatOpenId(sessionId);
      setChatDraft("");
      // Clear stale output so each conversation starts fresh.
      setChatOutputs((prev) => { const next = new Map(prev); next.delete(sessionId); return next; });
      // Proactively ensure PTY and start streaming output.
      ensurePty(agent.cwd).then((ptyId) => {
        if (ptyId) startOutputSub(sessionId, ptyId);
      }).catch(() => {});
    }
  }

  // ── Grouping ──────────────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const byCwd = new Map<string, AgentState[]>();
    for (const a of agents) {
      const list = byCwd.get(a.cwd);
      if (list) list.push(a);
      else byCwd.set(a.cwd, [a]);
    }
    const result = Array.from(byCwd.entries()).map(([cwd, list]) => {
      list.sort((a, b) => {
        const so = statusOrder(a.status) - statusOrder(b.status);
        return so !== 0 ? so : b.lastActivityAt - a.lastActivityAt;
      });
      return { cwd, agents: list };
    });
    result.sort((a, b) => {
      const so = statusOrder(a.agents[0].status) - statusOrder(b.agents[0].status);
      return so !== 0 ? so : b.agents[0].lastActivityAt - a.agents[0].lastActivityAt;
    });
    return result;
  }, [agents]);

  const totalAgents = agents.length;
  const totalSubs = agents.reduce((acc, a) => acc + a.subAgents.filter((s) => !s.finished).length, 0);

  // ── Collapsed sidebar ─────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <>
        <aside id="agent-sidebar" className="collapsed">
          <button className="collapse-btn" onClick={onToggle} title="Show agents">←</button>
          <span className={`dot ${connected ? "ok" : "ko"}`} />
          <span className="count-vert">{totalAgents}</span>
        </aside>
        {renderTerminals()}
      </>
    );
  }

  // ── Expanded sidebar ──────────────────────────────────────────────────────
  return (
    <>
      <aside id="agent-sidebar">
        <header>
          <span className={`dot ${connected ? "ok" : "ko"}`} />
          <h2>Live Claude sessions</h2>
          <span className="count">
            {totalAgents}{totalSubs > 0 ? ` · ${totalSubs} sub` : ""}
          </span>
          <button
            className="spawn-btn-header"
            onClick={() => { setSpawnDefaultCwd(""); setShowSpawnPanel(true); }}
            title="Launch a new Claude session"
          >
            ⚡
          </button>
          <button className="collapse-btn" onClick={onToggle} title="Collapse">→</button>
        </header>

        <div className="groups">
          {groups.length === 0 ? (
            <div className="empty">
              <span>No active session.</span>
              <button className="empty-spawn-btn" onClick={() => { setSpawnDefaultCwd(""); setShowSpawnPanel(true); }}>
                ⚡ Launch Claude
              </button>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.cwd} className="project">
                <h3 title={g.cwd}>{shortName(g.cwd)}</h3>
                <ul>
                  {g.agents.map((a) => {
                    const pty = ptySessions.find((p) => p.cwd === a.cwd);
                    return (
                      <AgentRow
                        key={a.sessionId}
                        agent={a}
                        pty={pty}
                        resuming={resumingId === a.sessionId}
                        chatOpen={chatOpenId === a.sessionId}
                        chatDraft={chatOpenId === a.sessionId ? chatDraft : ""}
                        chatSending={chatSendingId === a.sessionId}
                        chatAwaiting={chatAwaitingId === a.sessionId}
                        chatOutput={chatOutputs.get(a.sessionId) ?? ""}
                        onClick={() => handleAgentClick(a)}
                        onChatToggle={() => toggleChat(a.sessionId, a)}
                        onChatDraftChange={setChatDraft}
                        onChatSend={(msg) => void sendChatMessage(a, msg)}
                      />
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </aside>

      {showSpawnPanel && (
        <SpawnPanel
          recentCwds={recentCwds}
          defaultCwd={spawnDefaultCwd || undefined}
          onClose={() => setShowSpawnPanel(false)}
          onSpawned={(session) => { setShowSpawnPanel(false); handleSpawned(session); }}
        />
      )}

      {renderTerminals()}
    </>
  );

  // ── Floating terminal windows (non-minimized only) ─────────────────────
  function renderTerminals() {
    return ptySessions
      .filter((p) => !p.minimized)
      .map((p) => (
        <TerminalOverlay
          key={p.ptyId}
          ptyId={p.ptyId}
          cwd={p.cwd}
          onMinimize={() => minimizeTerminal(p.ptyId)}
          onClose={() => closeTerminal(p.ptyId)}
          onRespawn={(cwd) => { closeTerminal(p.ptyId); void spawnFresh(cwd); }}
        />
      ));
  }
}

// ── AgentRow ────────────────────────────────────────────────────────────────
function AgentRow({
  agent,
  pty,
  resuming,
  chatOpen,
  chatDraft,
  chatSending,
  chatAwaiting,
  chatOutput,
  onClick,
  onChatToggle,
  onChatDraftChange,
  onChatSend,
}: {
  agent: AgentState;
  pty?: ActivePty;
  resuming: boolean;
  chatOpen: boolean;
  chatDraft: string;
  chatSending: boolean;
  chatAwaiting: boolean;
  chatOutput: string;
  onClick: () => void;
  onChatToggle: () => void;
  onChatDraftChange: (v: string) => void;
  onChatSend: (msg: string) => void;
}) {
  const liveSubs = agent.subAgents.filter((s) => !s.finished);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  // Auto-focus the chat input when it opens.
  useEffect(() => {
    if (chatOpen) inputRef.current?.focus();
  }, [chatOpen]);

  // Auto-scroll output to bottom on new content.
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [chatOutput]);

  let termTitle: string;
  if (resuming)            termTitle = "Opening Claude Code…";
  else if (pty?.minimized) termTitle = "Restore terminal";
  else if (pty)            termTitle = "Terminal open — click to bring up";
  else                     termTitle = `Resume this session in Claude Code (${agent.sessionId.slice(0, 8)}…)`;

  return (
    <li className="agent">
      <div className="agent-head-row">
        {/* ── Main clickable area (status + tool detail) ─────────────────── */}
        <div
          className={`agent-head ${resuming ? "resuming" : ""}`}
          role="button"
          tabIndex={0}
          onClick={resuming ? undefined : onClick}
          onKeyDown={(e) => { if (!resuming && (e.key === "Enter" || e.key === " ")) onClick(); }}
          title={termTitle}
          aria-busy={resuming}
        >
          <span className="icon teacher" style={spriteStyle(teacherSpriteFor(agent.sessionId))} />
          <div className="meta">
            <div className="line">
              <span className="status-dot" style={{ background: STATUS_COLOR[agent.status] }} />
              <span className="status">{STATUS_LABEL[agent.status]}</span>
              {agent.currentTool ? <span className="tool"> · {agent.currentTool}</span> : null}
            </div>
            {agent.currentToolDetail ? (
              <div className="detail" title={agent.currentToolDetail}>{agent.currentToolDetail}</div>
            ) : null}
          </div>
          {/* Terminal badge */}
          {resuming ? (
            <span className="terminal-badge resuming-badge" title="Launching…">···</span>
          ) : pty ? (
            <span
              className={`terminal-badge ${pty.minimized ? "minimized" : "active"}`}
              title={pty.minimized ? "Terminal minimized — click to restore" : "Terminal open"}
            >
              &gt;_
            </span>
          ) : (
            <span className="terminal-badge resume-hint" title={termTitle}>▶</span>
          )}
        </div>

        {/* ── Chat toggle button ─────────────────────────────────────────── */}
        <button
          className={`chat-toggle-btn ${chatOpen ? "active" : ""}`}
          onClick={(e) => { e.stopPropagation(); onChatToggle(); }}
          title={chatOpen ? "Close chat" : "Send a message to this agent"}
          aria-pressed={chatOpen}
        >
          💬
        </button>
      </div>

      {/* ── Inline chat panel ──────────────────────────────────────────────── */}
      {chatOpen && (
        <div className="chat-panel">
          {/* PTY output area */}
          {chatOutput ? (
            <pre ref={outputRef} className="chat-output">{chatOutput}</pre>
          ) : chatAwaiting ? (
            <div className="chat-thinking">Claude réfléchit…</div>
          ) : null}
          {/* Input row */}
          <div className="chat-input-row">
            <input
              ref={inputRef}
              className="chat-input"
              type="text"
              value={chatDraft}
              placeholder="Type a message…"
              disabled={chatSending}
              onChange={(e) => onChatDraftChange(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation(); // prevent Phaser from eating key events
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onChatSend(chatDraft);
                }
                if (e.key === "Escape") onChatToggle();
              }}
            />
            <button
              className="chat-send-btn"
              disabled={chatSending || !chatDraft.trim()}
              onClick={() => onChatSend(chatDraft)}
              title="Send (Enter)"
            >
              {chatSending ? "…" : "↵"}
            </button>
          </div>
        </div>
      )}

      {liveSubs.length > 0 && (
        <ul className="subs">
          {liveSubs.map((s) => <SubAgentRow key={s.id} sub={s} />)}
        </ul>
      )}
    </li>
  );
}

// ── SubAgentRow ─────────────────────────────────────────────────────────────
function SubAgentRow({ sub }: { sub: SubAgentState }) {
  return (
    <li className="sub-agent" tabIndex={0}>
      <span
        className="icon student"
        style={{
          backgroundImage: `url(/assets/sprites/${studentSpriteFor(sub.id)}.png)`,
          backgroundPosition: "-24px 0px",
          backgroundSize: "72px 96px",
          width: 24,
          height: 24,
          imageRendering: "pixelated",
          flex: "0 0 24px",
          backgroundRepeat: "no-repeat",
        }}
      />
      <div className="meta">
        <div className="name" title={sub.description}>{sub.description || "Sub-task"}</div>
        <div className="line">
          <span className="status-dot" style={{ background: STATUS_COLOR[sub.status] }} />
          <span className="status">{STATUS_LABEL[sub.status]}</span>
          {sub.currentTool ? <span className="tool"> · {sub.currentTool}</span> : null}
        </div>
        {sub.currentToolDetail ? (
          <div className="detail" title={sub.currentToolDetail}>{sub.currentToolDetail}</div>
        ) : null}
      </div>
    </li>
  );
}

function shortName(cwd: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
