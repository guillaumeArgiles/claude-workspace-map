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

  // ── Notifications ─────────────────────────────────────────────────────────
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    () => (typeof Notification !== "undefined" ? Notification.permission : "denied")
  );
  /** Kept fresh each render so the notification onclick can open the right terminal. */
  const agentClickRef = useRef<(a: AgentState) => void>(() => {});
  /** Previous status per sessionId — lets us fire only on transitions. */
  const prevStatusRef = useRef<Map<string, string>>(new Map());

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
  /** Spawn a brand-new Claude session in cwd and open its terminal. */
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
    fetch(`/api/sessions/${ptyId}`, { method: "DELETE" }).catch(() => {});
  }

  /**
   * Open (or restore) a terminal for an existing agent session.
   * Uses `claude --continue` to resume the last conversation in cwd.
   * Note: `--resume <UUID>` triggers a git-diff crash in Claude Code's Bun
   * runtime for non-recent sessions; `--continue` is safe.
   */
  async function resumeSession(agent: AgentState) {
    if (resumingId) return; // debounce
    setResumingId(agent.sessionId);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: agent.cwd, command: "claude --continue" }),
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

  /** Clicking an agent row opens its terminal (or resumes it). */
  function handleAgentClick(agent: AgentState) {
    const pty = ptySessions.find((p) => p.cwd === agent.cwd);
    if (pty) {
      restoreTerminal(pty.ptyId);
    } else {
      void resumeSession(agent);
    }
  }
  // Keep the ref fresh so notification onclick always calls the current version.
  agentClickRef.current = handleAgentClick;

  // ── Notification helpers ──────────────────────────────────────────────────

  /** Request browser notification permission and update state. */
  async function requestNotifPermission() {
    if (!("Notification" in window)) return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
  }

  /** Fire a desktop notification for an agent that needs attention. */
  function showNotification(agent: AgentState) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const isBlocked = agent.status === "blocked";
    const title = isBlocked
      ? `🚫 ${agent.projectName} est bloqué`
      : `✋ ${agent.projectName} attend ta réponse`;
    const body = agent.currentToolDetail
      ?? (isBlocked ? "Besoin d'aide" : "En attente de validation");
    // `tag` deduplicates: a second notification for the same session replaces
    // the first instead of stacking.
    const n = new Notification(title, { body, tag: agent.sessionId });
    n.onclick = () => {
      window.focus();
      agentClickRef.current(agent);
      n.close();
    };
  }

  // ── Transition watcher — fires notifications on status changes ────────────
  useEffect(() => {
    const prev = prevStatusRef.current;
    for (const agent of agents) {
      const prevStatus = prev.get(agent.sessionId);
      const newStatus = agent.status;
      // prevStatus === undefined means first snapshot — skip to avoid
      // notifying about agents that were already blocked before the page loaded.
      if (
        prevStatus !== undefined &&
        prevStatus !== newStatus &&
        (newStatus === "awaiting_approval" || newStatus === "blocked")
      ) {
        showNotification(agent);
      }
      prev.set(agent.sessionId, newStatus);
    }
    // Remove stale entries for sessions that disappeared.
    const ids = new Set(agents.map((a) => a.sessionId));
    for (const id of prev.keys()) {
      if (!ids.has(id)) prev.delete(id);
    }
  }, [agents]); // eslint-disable-line react-hooks/exhaustive-deps

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
          {"Notification" in window && (
            <button
              className={`notif-btn ${notifPermission === "granted" ? "active" : ""}`}
              onClick={notifPermission !== "granted" ? requestNotifPermission : undefined}
              title={
                notifPermission === "granted"
                  ? "Notifications activées"
                  : notifPermission === "denied"
                  ? "Notifications bloquées — réactiver dans les préférences du navigateur"
                  : "Activer les notifications desktop"
              }
            >
              🔔
            </button>
          )}
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
                        onClick={() => handleAgentClick(a)}
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
  onClick,
}: {
  agent: AgentState;
  pty?: ActivePty;
  resuming: boolean;
  onClick: () => void;
}) {
  const liveSubs = agent.subAgents.filter((s) => !s.finished);

  let termTitle: string;
  if (resuming)            termTitle = "Opening Claude Code…";
  else if (pty?.minimized) termTitle = "Restore terminal";
  else if (pty)            termTitle = "Terminal open — click to bring up";
  else                     termTitle = `Open in Claude Code (${agent.sessionId.slice(0, 8)}…)`;

  return (
    <li className="agent">
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
            <span
              className={`status-dot${agent.status === "awaiting_approval" || agent.status === "blocked" ? " status-dot-pulse" : ""}`}
              style={{ background: STATUS_COLOR[agent.status] }}
            />
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
