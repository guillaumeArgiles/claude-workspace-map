import { useEffect, useRef } from "react";
import { voiceService } from "../services/voiceService";
import type { AgentState, ServerEvent } from "../../shared/agent-types";
import type { Locale } from "../../shared/config-schema";

/**
 * Headless component that bridges Le Professeur's prose responses to the
 * Web-Speech-API-powered voice service.
 *
 * **Pipeline — JSONL, not PTY** : the PTY output is a noisy stream of
 * cursor positioning, status spinners, prompt echoes, hook errors — too
 * messy to filter reliably for TTS. The watcher already parses Claude's
 * JSONL transcripts and exposes the clean prose as `AgentState.
 * lastAssistantText`. We subscribe to the `/api/events` SSE stream and
 * watch that field change for the Professor's session.
 *
 * **Identifying the Professor by cwd pattern** : every Claude session run
 * inside the dedicated `~/.claude-workspace-map/professor/` dir is a
 * Professor. We match `agent.cwd.endsWith(PROFESSOR_DIR_SUFFIX)` instead
 * of relying on the `professor_spawned` uiBus event — that approach
 * missed cases where the Professor was spawned before the page loaded
 * (no event fires for already-running sessions on mount).
 *
 * `enabled` and `locale` come from AppConfig — toggled in Settings. We
 * pipe them through to the voice service so it stays in sync.
 */
export function ProfessorVoiceBridge({
  enabled,
  locale,
}: {
  enabled: boolean;
  locale: Locale;
}) {
  useEffect(() => {
    voiceService.setEnabled(enabled);
  }, [enabled]);
  useEffect(() => {
    voiceService.setLocale(locale);
  }, [locale]);

  /**
   * Per-Professor-sessionId tracking : remember the last text we already
   * sent to TTS, keyed by sessionId. A new session resets its own entry
   * automatically when the bridge first sees its agent_spawned event.
   */
  const spokenBySession = useRef<Map<string, string>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/events");
    eventSourceRef.current = es;

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as ServerEvent;
        switch (data.type) {
          case "snapshot":
            // On first connect we seed the per-session tracking WITHOUT
            // speaking — we don't want to read the entire conversation
            // history on every page reload.
            for (const agent of data.agents) {
              if (!isProfessor(agent)) continue;
              spokenBySession.current.set(
                agent.sessionId,
                agent.lastAssistantText ?? ""
              );
            }
            break;
          case "agent_spawned":
            // A fresh Professor session is starting — initialise its tracking
            // entry to "" so the first response IS spoken.
            if (isProfessor(data.agent)) {
              spokenBySession.current.set(data.agent.sessionId, "");
            }
            break;
          case "agent_updated":
            if (isProfessor(data.agent)) handleProfessorUpdate(data.agent);
            break;
          case "agent_removed":
            spokenBySession.current.delete(data.sessionId);
            break;
        }
      } catch {
        /* skip malformed events */
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      voiceService.cancel();
    };

    function handleProfessorUpdate(agent: AgentState) {
      const text = agent.lastAssistantText?.trim();
      if (!text) return;
      const prev = spokenBySession.current.get(agent.sessionId) ?? "";
      if (text === prev) return;
      // Detect delta vs full replacement. When Claude streams a turn,
      // each JSONL update appends — so `text.startsWith(prev)` lets us
      // speak only the new tail. Otherwise it's a fresh turn → speak
      // the whole new text.
      const fragment = text.startsWith(prev) ? text.slice(prev.length) : text;
      spokenBySession.current.set(agent.sessionId, text);
      const trimmed = fragment.trim();
      if (!trimmed) return;
      // eslint-disable-next-line no-console
      console.log("[TTS]", JSON.stringify(trimmed));
      voiceService.speak(trimmed);
    }
  }, []);

  return null;
}

/** Identifies the Professor by his dedicated working directory. */
const PROFESSOR_DIR_SUFFIX = "/.claude-workspace-map/professor";

function isProfessor(agent: AgentState): boolean {
  return agent.cwd.endsWith(PROFESSOR_DIR_SUFFIX);
}
