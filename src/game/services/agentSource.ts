import type { AgentState, ServerEvent } from "../../../shared/agent-types";

type Listener<T> = (data: T) => void;

interface Listeners {
  spawn: Set<Listener<AgentState>>;
  update: Set<Listener<AgentState>>;
  remove: Set<Listener<string>>;
  snapshot: Set<Listener<AgentState[]>>;
  error: Set<Listener<Event>>;
  open: Set<Listener<void>>;
}

/**
 * Subscribes to the Node backend's SSE stream and maintains a local map of
 * currently active Claude sessions. Phaser-agnostic on purpose so the scene
 * can stay focused on rendering.
 */
export class AgentSource {
  private es?: EventSource;
  private agents = new Map<string, AgentState>();
  private listeners: Listeners = {
    spawn: new Set(),
    update: new Set(),
    remove: new Set(),
    snapshot: new Set(),
    error: new Set(),
    open: new Set(),
  };

  start(url = "/api/events"): void {
    this.es = new EventSource(url);
    this.es.onopen = () => this.listeners.open.forEach((l) => l());
    this.es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as ServerEvent;
        this.dispatch(ev);
      } catch (err) {
        console.warn("[AgentSource] malformed event:", err);
      }
    };
    this.es.onerror = (e) => this.listeners.error.forEach((l) => l(e));
  }

  stop(): void {
    this.es?.close();
    this.es = undefined;
  }

  current(): AgentState[] {
    return Array.from(this.agents.values());
  }

  on(event: "spawn", listener: Listener<AgentState>): void;
  on(event: "update", listener: Listener<AgentState>): void;
  on(event: "remove", listener: Listener<string>): void;
  on(event: "snapshot", listener: Listener<AgentState[]>): void;
  on(event: "open", listener: Listener<void>): void;
  on(event: "error", listener: Listener<Event>): void;
  on(event: keyof Listeners, listener: (data: never) => void): void {
    (this.listeners[event] as Set<(data: never) => void>).add(listener);
  }

  off(event: keyof Listeners, listener: (data: never) => void): void {
    (this.listeners[event] as Set<(data: never) => void>).delete(listener);
  }

  private dispatch(ev: ServerEvent): void {
    switch (ev.type) {
      case "snapshot":
        this.agents.clear();
        for (const a of ev.agents) this.agents.set(a.sessionId, a);
        this.listeners.snapshot.forEach((l) => l(ev.agents));
        break;
      case "agent_spawned":
        this.agents.set(ev.agent.sessionId, ev.agent);
        this.listeners.spawn.forEach((l) => l(ev.agent));
        break;
      case "agent_updated":
        this.agents.set(ev.agent.sessionId, ev.agent);
        this.listeners.update.forEach((l) => l(ev.agent));
        break;
      case "agent_removed":
        this.agents.delete(ev.sessionId);
        this.listeners.remove.forEach((l) => l(ev.sessionId));
        break;
    }
  }
}
