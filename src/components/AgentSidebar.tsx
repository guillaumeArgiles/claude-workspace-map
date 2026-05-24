import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentState,
  ServerEvent,
  SubAgentState,
  PendingQuestion,
} from "../../shared/agent-types";
import {
  teacherSpriteFor,
  studentSpriteFor,
} from "../../shared/agent-sprites";
import { STATUS_COLOR, STATUS_LABEL, statusOrder } from "../../shared/agent-ui";
import { uiBus } from "../game/services/uiBus";
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
  // Re-sync on mount (in case the lazy initializer ran before the API was
  // fully available) and whenever the tab regains focus (user may have changed
  // permissions in browser settings while away).
  useEffect(() => {
    const sync = () => {
      if ("Notification" in window) setNotifPermission(Notification.permission);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  /** Kept fresh each render so the notification onclick can open the right terminal. */
  const agentClickRef = useRef<(a: AgentState) => void>(() => {});
  /** Kept fresh for the uiBus open_terminal handler (stable closure via ref). */
  const agentsRef = useRef<AgentState[]>([]);
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

  // ── Professor NPC interaction (Phaser → React) ───────────────────────────
  const spawnProfessorRef = useRef<() => void>(() => {});
  spawnProfessorRef.current = () => void spawnProfessor();
  useEffect(() => {
    const handler = () => spawnProfessorRef.current();
    uiBus.on("spawn_professor", handler);
    return () => uiBus.off("spawn_professor", handler);
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
   * Open a terminal for an existing agent's cwd.
   *
   * We intentionally omit --continue / --resume: both flags trigger a
   * git-diff crash in Claude Code's Bun runtime when the conversation is
   * long or the session is not recent (unhandled exception in the diff-stats
   * initialiser). Opening a plain `claude` session in the correct cwd lets
   * the user manually run `--continue` inside if they want history.
   */
  async function resumeSession(agent: AgentState) {
    if (resumingId) return; // debounce
    setResumingId(agent.sessionId);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: agent.cwd }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { ptyId } = (await res.json()) as { ptyId: string };
      handleSpawned({ ptyId, cwd: agent.cwd, spawnedAt: Date.now() });
    } catch (err) {
      console.error("Failed to open session:", err);
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
  // Keep refs fresh every render.
  agentClickRef.current = handleAgentClick;
  agentsRef.current = agents;

  /** Spawn the Professor NPC session and open its terminal. */
  async function spawnProfessor() {
    try {
      const res = await fetch("/api/professor/spawn", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const { ptyId, cwd } = (await res.json()) as { ptyId: string; cwd: string };
      handleSpawned({ ptyId, cwd, spawnedAt: Date.now() });
    } catch (err) {
      console.error("Failed to spawn Professor:", err);
    }
  }

  /** Dismiss a single agent (hide until it has new activity). */
  function dismissAgent(sessionId: string) {
    fetch(`/api/agents/${sessionId}`, { method: "DELETE" }).catch(() => {});
  }

  /** Dismiss all done/idle agents in one shot. */
  function dismissAllInactive() {
    fetch("/api/agents", { method: "DELETE" }).catch(() => {});
  }

  // ── uiBus: open_terminal from the Phaser game ─────────────────────────────
  useEffect(() => {
    const handler = ({ sessionId }: { sessionId: string }) => {
      const agent = agentsRef.current.find((a) => a.sessionId === sessionId);
      if (agent) agentClickRef.current(agent);
    };
    uiBus.on("open_terminal", handler);
    return () => uiBus.off("open_terminal", handler);
  }, []); // stable via refs

  // ── Notification helpers ──────────────────────────────────────────────────

  /** Request browser notification permission and update state. */
  async function requestNotifPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "denied") {
      alert("Notifications bloquées par le navigateur.\nRéactive-les dans Préférences > Notifications.");
      return;
    }
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
  const inactiveCount = agents.filter((a) => a.status === "done" || a.status === "idle").length;

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  /** Index into the flat agent list for Tab cycling. */
  const cycleIdxRef = useRef(0);
  /** Always-current snapshot of reactive values used inside the stable handler. */
  const kbRef = useRef({ groups, ptySessions, inactiveCount });
  kbRef.current = { groups, ptySessions, inactiveCount };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never fire while the user is typing in a form field or the spawn panel.
      const t = e.target as HTMLElement;
      if (
        t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable
      ) return;

      const { groups, ptySessions, inactiveCount } = kbRef.current;

      // 1 / 2 / 3 → jump player to house 1/2/3
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        const group = groups[Number(e.key) - 1];
        if (group) uiBus.emit("highlight_agent", { id: group.agents[0].sessionId });
        return;
      }

      switch (e.key) {
        // N → open spawn panel
        case "n": case "N":
          e.preventDefault();
          setShowSpawnPanel(true);
          setSpawnDefaultCwd("");
          break;

        // P → spawn Professor
        case "p": case "P":
          e.preventDefault();
          spawnProfessorRef.current();
          break;

        // Backspace → bulk clear done/idle agents
        case "Backspace":
          if (inactiveCount > 0) {
            e.preventDefault();
            fetch("/api/agents", { method: "DELETE" }).catch(() => {});
          }
          break;

        // B → request desktop notification permission (or warn if denied)
        case "b": case "B":
          if ("Notification" in window) {
            e.preventDefault();
            if (Notification.permission === "denied") {
              // Browser blocked — user must re-enable in browser settings.
              alert("Notifications bloquées par le navigateur.\nRéactive-les dans Préférences > Notifications.");
            } else {
              void Notification.requestPermission().then((p) => setNotifPermission(p));
            }
          }
          break;

        // Tab → cycle through agents (player walks to each one in turn)
        case "Tab": {
          e.preventDefault();
          const flat = groups.flatMap((g) => g.agents);
          if (!flat.length) break;
          cycleIdxRef.current = (cycleIdxRef.current + 1) % flat.length;
          uiBus.emit("highlight_agent", { id: flat[cycleIdxRef.current].sessionId });
          break;
        }

        // Escape → close the most-recently-opened terminal overlay
        case "Escape": {
          const open = ptySessions.filter((p) => !p.minimized);
          if (open.length) {
            e.preventDefault();
            const last = open[open.length - 1];
            setPtySessions((prev) => prev.filter((p) => p.ptyId !== last.ptyId));
            fetch(`/api/sessions/${last.ptyId}`, { method: "DELETE" }).catch(() => {});
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // stable: kbRef + stable setters

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
          <button
            className="professor-btn-header"
            onClick={() => void spawnProfessor()}
            title="Invoquer le Professeur"
          >
            🎓
          </button>
          {inactiveCount > 0 && (
            <button
              className="clear-btn-header"
              onClick={dismissAllInactive}
              title={`Clear ${inactiveCount} done/idle agent${inactiveCount > 1 ? "s" : ""}`}
            >
              🧹
            </button>
          )}
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
                        onDismiss={() => dismissAgent(a.sessionId)}
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
  onDismiss,
}: {
  agent: AgentState;
  pty?: ActivePty;
  resuming: boolean;
  onClick: () => void;
  onDismiss: () => void;
}) {
  const liveSubs = agent.subAgents.filter((s) => !s.finished);

  let termTitle: string;
  if (resuming)            termTitle = "Opening Claude Code…";
  else if (pty?.minimized) termTitle = "Restore terminal";
  else if (pty)            termTitle = "Terminal open — click to bring up";
  else                     termTitle = `Open in Claude Code (${agent.sessionId.slice(0, 8)}…)`;

  const hasPending = agent.pendingPlan !== undefined ||
    (agent.pendingQuestions && agent.pendingQuestions.length > 0);

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
        {/* Dismiss button — visible on hover */}
        <button
          className="dismiss-btn"
          title="Dismiss agent"
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        >
          ×
        </button>
      </div>

      {/* Inline approval widget — shown when ExitPlanMode or AskUserQuestion is pending */}
      {hasPending && (
        <PendingApprovalWidget agent={agent} pty={pty} onOpenTerminal={onClick} />
      )}

      {liveSubs.length > 0 && (
        <ul className="subs">
          {liveSubs.map((s) => <SubAgentRow key={s.id} sub={s} />)}
        </ul>
      )}
    </li>
  );
}

// ── PendingApprovalWidget ────────────────────────────────────────────────────
/**
 * Inline card rendered below an agent row when Claude is waiting for the
 * user's input (ExitPlanMode → plan, AskUserQuestion → questions).
 * Clicking "Open Terminal" opens the agent's Claude Code session so the user
 * can type their response directly in the terminal.
 */
function PendingApprovalWidget({
  agent,
  pty,
  onOpenTerminal,
}: {
  agent: AgentState;
  pty?: ActivePty;
  onOpenTerminal: () => void;
}) {
  // If no PTY is open for this agent, it was started outside FleetView.
  // We can't write to its stdin — just tell the user where to look.
  const canInteract = !!pty;

  if (agent.pendingPlan) {
    return <PlanWidget plan={agent.pendingPlan} canInteract={canInteract} onOpen={onOpenTerminal} />;
  }
  if (agent.pendingQuestions && agent.pendingQuestions.length > 0) {
    return <QuestionsWidget questions={agent.pendingQuestions} canInteract={canInteract} onOpen={onOpenTerminal} />;
  }
  return null;
}

function PlanWidget({ plan, canInteract, onOpen }: { plan: string; canInteract: boolean; onOpen: () => void }) {
  const lines = plan.split("\n").filter((l) => l.trim());
  const title = (lines[0] ?? "Plan").replace(/^#+\s*/, "");
  // Grab up to 3 body lines as a preview, skip further headings.
  const bodyLines = lines.slice(1).filter((l) => !l.startsWith("#")).slice(0, 3);
  const preview = bodyLines.join(" ").slice(0, 140);

  return (
    <div className="approval-widget">
      <div className="approval-header">
        <span className="approval-icon">📋</span>
        <span className="approval-title">{title}</span>
      </div>
      {preview && <p className="approval-preview">{preview}{preview.length >= 140 ? "…" : ""}</p>}
      <div className="approval-actions">
        {canInteract ? (
          <button className="approval-btn" onClick={onOpen}>
            Répondre dans le terminal
          </button>
        ) : (
          <span className="approval-external-hint">
            ↗ Réponds dans ton terminal Claude Code
          </span>
        )}
      </div>
    </div>
  );
}

function QuestionsWidget({
  questions,
  canInteract,
  onOpen,
}: {
  questions: PendingQuestion[];
  canInteract: boolean;
  onOpen: () => void;
}) {
  const q = questions[0];
  return (
    <div className="approval-widget">
      <div className="approval-header">
        <span className="approval-icon">❓</span>
        <span className="approval-title">{q.question}</span>
      </div>
      <ul className="approval-options">
        {q.options.map((opt, i) => (
          <li key={i} className="approval-option">
            <span className="option-num">{i + 1}.</span>
            <span className="option-label">{opt.label}</span>
            {opt.description && (
              <span className="option-desc">{opt.description}</span>
            )}
          </li>
        ))}
      </ul>
      {questions.length > 1 && (
        <p className="approval-more">+{questions.length - 1} more question{questions.length > 2 ? "s" : ""}</p>
      )}
      <div className="approval-actions">
        {canInteract ? (
          <button className="approval-btn" onClick={onOpen}>
            Répondre dans le terminal
          </button>
        ) : (
          <span className="approval-external-hint">
            ↗ Réponds dans ton terminal Claude Code
          </span>
        )}
      </div>
    </div>
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
