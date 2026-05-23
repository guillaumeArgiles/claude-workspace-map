/**
 * Tiny typed event bus shared by the React UI and the Phaser scene. Lets us
 * fire UI intents (e.g. "highlight this agent") without coupling them.
 */

type Handler<T> = (data: T) => void;

export interface UiEvents {
  /** Tell the scene to highlight an agent (or sub-agent) by id. */
  highlight_agent: { id: string };
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
