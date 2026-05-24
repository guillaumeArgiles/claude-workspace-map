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

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

/**
 * Subscribes to the Node backend's SSE stream and maintains a local map of
 * currently active Claude sessions. Phaser-agnostic on purpose so the scene
 * can stay focused on rendering.
 *
 * Reconnect strategy: we drive the loop ourselves rather than relying on the
 * browser's default EventSource auto-reconnect, so we can:
 *   - apply exponential backoff (1s → 2s → 4s → … → 30s cap)
 *   - reset the backoff on a clean reconnect
 *   - emit `error` once per disconnect and `open` once per real reconnect
 *
 * The server replays a fresh `snapshot` event on every connect, so state is
 * always reconciled after a drop — no need for an extra REST fetch on top.
 */
export class AgentSource {
  private es?: EventSource;
  private url = "/api/events";
  private agents = new Map<string, AgentState>();
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private listeners: Listeners = {
    spawn: new Set(),
    update: new Set(),
    remove: new Set(),
    snapshot: new Set(),
    error: new Set(),
    open: new Set(),
  };

  start(url = "/api/events"): void {
    this.url = url;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.es?.close();
    this.es = undefined;
  }

  private connect(): void {
    if (this.stopped) return;
    this.es = new EventSource(this.url);

    this.es.onopen = () => {
      // Clean reconnect — reset backoff and let listeners know we're live again.
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.listeners.open.forEach((l) => l());
    };

    this.es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as ServerEvent;
        this.dispatch(ev);
      } catch (err) {
        console.warn("[AgentSource] malformed event:", err);
      }
    };

    this.es.onerror = (e) => {
      this.listeners.error.forEach((l) => l(e));
      // Close + schedule our own retry instead of letting the browser hammer.
      this.es?.close();
      this.es = undefined;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
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
