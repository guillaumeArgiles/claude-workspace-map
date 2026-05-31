/**
 * Tiny typed event bus shared by the React UI and the Phaser scene. Lets us
 * fire UI intents (e.g. "highlight this agent") without coupling them.
 */

type Handler<T> = (data: T) => void;

export interface UiEvents {
  /** Tell the scene to highlight an agent (or sub-agent) by id. */
  highlight_agent: { id: string };
  /** Tell the sidebar to open the terminal for a given Claude session. */
  open_terminal: { sessionId: string };
  /** Player pressed E on the Professor NPC — sidebar should spawn the Professor session. */
  spawn_professor: Record<string, never>;
  /**
   * Fired by the sidebar once Le Professeur's PTY has been spawned. Carries
   * the ptyId so other listeners (e.g. ProfessorVoiceBridge) can hook into
   * his output stream for TTS without re-running the spawn API.
   */
  professor_spawned: { ptyId: string; cwd: string };
  /**
   * Fired by any Phaser-side modal (agent menu, approval panel) to tell the
   * sidebar to suspend its global keyboard shortcuts. `open=true` when the
   * modal opens, `open=false` when it closes. Multiple modals are coalesced
   * by the sidebar via a refcount.
   */
  modal_open_changed: { open: boolean };
}

class UiBus {
  private listeners = new Map<keyof UiEvents, Set<Handler<unknown>>>();

  on<K extends keyof UiEvents>(event: K, handler: Handler<UiEvents[K]>): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as Handler<unknown>);
  }

  off<K extends keyof UiEvents>(event: K, handler: Handler<UiEvents[K]>): void {
    this.listeners.get(event)?.delete(handler as Handler<unknown>);
  }

  emit<K extends keyof UiEvents>(event: K, data: UiEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const h of set) (h as Handler<UiEvents[K]>)(data);
  }
}

export const uiBus = new UiBus();

// DEBUG : expose the singleton so Chrome MCP / DevTools can emit/inspect.
// Dynamic imports get a different module instance under Vite (?v=hash cache
// busting on static imports), so `import('/src/game/services/uiBus')` would
// give a fresh empty bus. Window-stash is the only reliable access path.
if (typeof window !== "undefined") {
  (window as unknown as { __uiBus: UiBus }).__uiBus = uiBus;
}
