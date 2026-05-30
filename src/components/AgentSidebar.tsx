import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentState,
  ServerEvent,
} from "../../shared/agent-types";
import { statusOrder } from "../../shared/agent-ui";
import { uiBus } from "../game/services/uiBus";
import { useTranslation, t as translate } from "../i18n";
import { SpawnPanel } from "./SpawnPanel";
import { TerminalOverlay } from "./TerminalOverlay";
import { CommandPalette, type CommandItem } from "./CommandPalette";
import { AgentRow, type ActivePty } from "./AgentRow";

export type { ActivePty };

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

// ── Props ───────────────────────────────────────────────────────────────────
interface AgentSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onOpenSettings: () => void;
  onOpenStats: () => void;
}

// ── Component ───────────────────────────────────────────────────────────────
export function AgentSidebar({ collapsed, onToggle, onOpenSettings, onOpenStats }: AgentSidebarProps) {
  const { t, plural } = useTranslation();
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [connected, setConnected] = useState(false);
  const [ptySessions, setPtySessions] = useState<ActivePty[]>([]);
  const [showSpawnPanel, setShowSpawnPanel] = useState(false);
  const [spawnDefaultCwd, setSpawnDefaultCwd] = useState("");
  const [showCmdPalette, setShowCmdPalette] = useState(false);
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
      alert(t("notif.blocked.alert"));
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
      ? t("notif.title.blocked", { project: agent.projectName })
      : t("notif.title.awaiting", { project: agent.projectName });
    const body = agent.currentToolDetail
      ?? (isBlocked ? t("notif.body.blocked") : t("notif.body.awaiting"));
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

  // ── Command palette items ─────────────────────────────────────────────────
  const paletteItems = useMemo<CommandItem[]>(() => {
    const out: CommandItem[] = [];
    // Agents — full sidebar-style rows (sprite, status, sub-agents nested,
    // pending-approval widget, dismiss × on hover), grouped by project (cwd).
    // Same component as the sidebar, so the visual is identical in both
    // surfaces. Default action = open terminal.
    for (const g of groups) {
      const projectName = shortName(g.cwd);
      const groupLabel = t("palette.group.project", { name: projectName });
      for (const a of g.agents) {
        const pty = ptySessions.find((p) => p.cwd === a.cwd);
        out.push({
          kind: "agent",
          id: `agent:${a.sessionId}`,
          group: groupLabel,
          agent: a,
          pty,
          resuming: resumingId === a.sessionId,
          onSelect: () => handleAgentClick(a),
          onDismiss: () => dismissAgent(a.sessionId),
        });
      }
    }
    // Actions — global commands. Shortcuts visible in `hint` mirror the keys
    // bound on `window` so the palette is also a keyboard cheat-sheet.
    const actionGroup = t("palette.group.actions");
    out.push({
      id: "action:new-session",
      label: t("action.new_session"),
      hint: "N",
      group: actionGroup,
      icon: "⚡",
      onSelect: () => { setSpawnDefaultCwd(""); setShowSpawnPanel(true); },
    });
    out.push({
      id: "action:professor",
      label: t("action.spawn_professor"),
      hint: "P",
      group: actionGroup,
      icon: "🎓",
      onSelect: () => void spawnProfessor(),
    });
    out.push({
      id: "action:toggle-sidebar",
      label: collapsed ? t("action.show_sidebar") : t("action.hide_sidebar"),
      hint: "S",
      group: actionGroup,
      icon: "▤",
      onSelect: () => onToggle(),
    });
    out.push({
      id: "action:settings",
      label: t("action.open_settings"),
      hint: ",",
      group: actionGroup,
      icon: "⚙",
      onSelect: () => onOpenSettings(),
    });
    out.push({
      id: "action:stats",
      label: t("action.open_stats"),
      hint: "D",
      group: actionGroup,
      icon: "📊",
      onSelect: () => onOpenStats(),
    });
    if (typeof Notification !== "undefined" && notifPermission !== "granted") {
      out.push({
        id: "action:enable-notif",
        label: t("action.enable_notifications"),
        hint: "B",
        group: actionGroup,
        icon: "🔔",
        onSelect: () => void requestNotifPermission(),
      });
    }
    if (inactiveCount > 0) {
      out.push({
        id: "action:clear-inactive",
        label: plural(inactiveCount, "action.clear_inactive"),
        hint: "⌫",
        group: actionGroup,
        icon: "🧹",
        onSelect: () => dismissAllInactive(),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, inactiveCount, collapsed, notifPermission, t, plural]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  /** Index into the flat agent list for Tab cycling. */
  const cycleIdxRef = useRef(0);
  /** Refcount of currently-open Phaser modals (agent menu, approval panel).
   *  When > 0, sidebar shortcuts (1/2/3/N/P/Tab/Esc) are suspended so the
   *  player can use the same keys inside the modal without side effects. */
  const modalDepthRef = useRef(0);
  /** Always-current snapshot of reactive values used inside the stable handler. */
  const kbRef = useRef({ groups, ptySessions, inactiveCount });
  kbRef.current = { groups, ptySessions, inactiveCount };
  /** Stable read of palette open state inside the global keydown handler. */
  const showCmdPaletteRef = useRef(showCmdPalette);
  showCmdPaletteRef.current = showCmdPalette;
  /** Props captured into refs so the (stable) keydown handler always invokes
   *  the latest callback, even after parent re-renders. */
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;
  const onOpenSettingsRef = useRef(onOpenSettings);
  onOpenSettingsRef.current = onOpenSettings;
  const onOpenStatsRef = useRef(onOpenStats);
  onOpenStatsRef.current = onOpenStats;

  // Track modal open/close events from Phaser (RPGAgentMenuUI, RPGApprovalUI).
  useEffect(() => {
    const onModalChange = ({ open }: { open: boolean }) => {
      modalDepthRef.current = Math.max(0, modalDepthRef.current + (open ? 1 : -1));
    };
    uiBus.on("modal_open_changed", onModalChange);
    return () => uiBus.off("modal_open_changed", onModalChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Cmd+K / Ctrl+K → toggle command palette. Fires even when typing in a
      // form field (it's the universal "open palette" shortcut), but not when
      // a Phaser modal is up.
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        if (modalDepthRef.current > 0) return;
        e.preventDefault();
        setShowCmdPalette((s) => !s);
        return;
      }

      // Phaser-side modal is up — let the player drive the menu without
      // triggering the sidebar's house-jump / spawn / cycle shortcuts.
      if (modalDepthRef.current > 0) return;

      // Palette owns its own keyboard while open.
      if (showCmdPaletteRef.current) return;

      // Never fire while the user is typing in a form field or the spawn panel.
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
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
              // Module-level translate() reads currentLocale fresh; the stable
              // handler must not close over the hook's locale-bound `t`.
              alert(translate("notif.blocked.alert"));
            } else {
              void Notification.requestPermission().then((p) => setNotifPermission(p));
            }
          }
          break;

        // S → toggle the sidebar list (palette-first UX exposes this as a
        // discoverable shortcut, visible in the palette hint as "S").
        case "s": case "S":
          e.preventDefault();
          onToggleRef.current();
          break;

        // , → open Settings (VS Code convention).
        case ",":
          e.preventDefault();
          onOpenSettingsRef.current();
          break;

        // D → open the workspace stats dashboard.
        case "d": case "D":
          e.preventDefault();
          onOpenStatsRef.current();
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
  // No visible chrome — palette is the entry point. Floating overlays (spawn
  // panel, palette, terminals) still need to render because the palette can
  // open them even when the sidebar shell is hidden.
  if (collapsed) {
    return (
      <>
        {showSpawnPanel && (
          <SpawnPanel
            recentCwds={recentCwds}
            defaultCwd={spawnDefaultCwd || undefined}
            onClose={() => setShowSpawnPanel(false)}
            onSpawned={(session) => { setShowSpawnPanel(false); handleSpawned(session); }}
          />
        )}
        {showCmdPalette && (
          <CommandPalette
            items={paletteItems}
            onClose={() => setShowCmdPalette(false)}
          />
        )}
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
          <h2>{t("sidebar.online")}</h2>
          <span className="count">
            {totalAgents}{totalSubs > 0 ? t("sidebar.count.sub", { n: totalSubs }) : ""}
          </span>
          <button
            className="spawn-btn-header"
            onClick={() => { setSpawnDefaultCwd(""); setShowSpawnPanel(true); }}
            title={t("sidebar.button.spawn.title")}
          >
            ⚡
          </button>
          <button
            className="professor-btn-header"
            onClick={() => void spawnProfessor()}
            title={t("sidebar.button.professor.title")}
          >
            🎓
          </button>
          {inactiveCount > 0 && (
            <button
              className="clear-btn-header"
              onClick={dismissAllInactive}
              title={plural(inactiveCount, "sidebar.button.clear.title")}
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
                  ? t("sidebar.button.notif.granted.title")
                  : notifPermission === "denied"
                  ? t("sidebar.button.notif.denied.title")
                  : t("sidebar.button.notif.default.title")
              }
            >
              🔔
            </button>
          )}
          <button
            className="settings-btn-header"
            onClick={onOpenSettings}
            title={t("sidebar.button.settings.title")}
          >
            ⚙
          </button>
          <button className="collapse-btn" onClick={onToggle} title={t("sidebar.button.collapse.title")}>→</button>
        </header>

        <div className="groups">
          {groups.length === 0 ? (
            <div className="empty">
              <span>{t("sidebar.empty.message")}</span>
              <button className="empty-spawn-btn" onClick={() => { setSpawnDefaultCwd(""); setShowSpawnPanel(true); }}>
                {t("sidebar.empty.launch")}
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

      {showCmdPalette && (
        <CommandPalette
          items={paletteItems}
          onClose={() => setShowCmdPalette(false)}
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


function shortName(cwd: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
