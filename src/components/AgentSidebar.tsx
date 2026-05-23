import { useEffect, useMemo, useState } from "react";
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
import { uiBus } from "../game/services/uiBus";

/**
 * One frame of the RPG-Maker sheet (96×128, 3 cols × 4 rows). Frame (col=1,
 * row=0) is the front-facing idle pose.
 */
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

interface AgentSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function AgentSidebar({ collapsed, onToggle }: AgentSidebarProps) {
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/events");
    const byId = new Map<string, AgentState>();

    const flush = () => setAgents(Array.from(byId.values()));

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
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

  /** Group agents by cwd (project). Each group is sorted by status priority. */
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
        if (so !== 0) return so;
        return b.lastActivityAt - a.lastActivityAt;
      });
      return { cwd, agents: list };
    });
    // Project ordering: most attention-grabbing agent first, fallback to recency.
    result.sort((a, b) => {
      const so = statusOrder(a.agents[0].status) - statusOrder(b.agents[0].status);
      if (so !== 0) return so;
      return b.agents[0].lastActivityAt - a.agents[0].lastActivityAt;
    });
    return result;
  }, [agents]);

  const totalAgents = agents.length;
  const totalSubs = agents.reduce(
    (acc, a) => acc + a.subAgents.filter((s) => !s.finished).length,
    0
  );

  if (collapsed) {
    return (
      <aside id="agent-sidebar" className="collapsed">
        <button
          className="collapse-btn"
          onClick={onToggle}
          title="Show agents"
        >
          ←
        </button>
        <span className={`dot ${connected ? "ok" : "ko"}`} />
        <span className="count-vert">{totalAgents}</span>
      </aside>
    );
  }

  return (
    <aside id="agent-sidebar">
      <header>
        <span className={`dot ${connected ? "ok" : "ko"}`} />
        <h2>Live Claude sessions</h2>
        <span className="count">
          {totalAgents}
          {totalSubs > 0 ? ` · ${totalSubs} sub` : ""}
        </span>
        <button
          className="collapse-btn"
          onClick={onToggle}
          title="Collapse"
        >
          →
        </button>
      </header>
      <div className="groups">
        {groups.length === 0 ? (
          <p className="empty">No active session in the last 30 minutes.</p>
        ) : (
          groups.map((g) => (
            <section key={g.cwd} className="project">
              <h3 title={g.cwd}>{shortName(g.cwd)}</h3>
              <ul>
                {g.agents.map((a) => (
                  <AgentRow key={a.sessionId} agent={a} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}

function AgentRow({ agent }: { agent: AgentState }) {
  const liveSubs = agent.subAgents.filter((s) => !s.finished);
  return (
    <li className="agent">
      <div
        className="agent-head"
        role="button"
        tabIndex={0}
        onClick={() => uiBus.emit("highlight_agent", { id: agent.sessionId })}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ")
            uiBus.emit("highlight_agent", { id: agent.sessionId });
        }}
        title="Focus this agent on the map"
      >
        <span className="icon teacher" style={spriteStyle(teacherSpriteFor(agent.sessionId))} />
        <div className="meta">
          <div className="line">
            <span className="status-dot" style={{ background: STATUS_COLOR[agent.status] }} />
            <span className="status">{STATUS_LABEL[agent.status]}</span>
            {agent.currentTool ? <span className="tool"> · {agent.currentTool}</span> : null}
          </div>
          {agent.currentToolDetail ? (
            <div className="detail" title={agent.currentToolDetail}>
              {agent.currentToolDetail}
            </div>
          ) : null}
        </div>
      </div>
      {liveSubs.length > 0 ? (
        <ul className="subs">
          {liveSubs.map((s) => (
            <SubAgentRow key={s.id} sub={s} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SubAgentRow({ sub }: { sub: SubAgentState }) {
  return (
    <li
      className="sub-agent"
      role="button"
      tabIndex={0}
      onClick={() => uiBus.emit("highlight_agent", { id: sub.id })}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ")
          uiBus.emit("highlight_agent", { id: sub.id });
      }}
      title="Focus this sub-agent on the map"
    >
      <span className="icon student" style={spriteStyle(studentSpriteFor(sub.id))} />
      <div className="meta">
        <div className="name" title={sub.description}>
          {sub.description || "Sub-task"}
        </div>
        <div className="line">
          <span className="status-dot" style={{ background: STATUS_COLOR[sub.status] }} />
          <span className="status">{STATUS_LABEL[sub.status]}</span>
          {sub.currentTool ? <span className="tool"> · {sub.currentTool}</span> : null}
        </div>
        {sub.currentToolDetail ? (
          <div className="detail" title={sub.currentToolDetail}>
            {sub.currentToolDetail}
          </div>
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
