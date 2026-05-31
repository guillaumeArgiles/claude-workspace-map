import { useEffect, useRef } from "react";
import { uiBus } from "../game/services/uiBus";
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
 * **Identifying the Professor** : `professor_spawned` (fired by
 * AgentSidebar.spawnProfessor) carries the cwd. We match incoming
 * `agent_updated` events by cwd to know we're looking at his agent.
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
  // Sync voice service state with user preferences as they change.
  useEffect(() => {
    voiceService.setEnabled(enabled);
  }, [enabled]);
  useEffect(() => {
    voiceService.setLocale(locale);
  }, [locale]);

  // Track : the Professor's cwd (used to identify his agent in SSE
  // events) and the last assistant text we already spoke (so we only
  // queue *new* prose).
  const professorCwdRef = useRef<string | null>(null);
  const lastSpokenRef = useRef<string>("");
  const eventSourceRef = useRef<EventSource | null>(null);

  // SSE subscription — opened once for the whole app lifetime. We don't
  // depend on the Professor being spawned to subscribe ; the stream is
  // cheap and we just need to be ready when his agent appears.
  useEffect(() => {
    const es = new EventSource("/api/events");
    eventSourceRef.current = es;

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as ServerEvent;
        switch (data.type) {
          case "snapshot":
            for (const agent of data.agents) handleAgent(agent);
            break;
          case "agent_spawned":
          case "agent_updated":
            handleAgent(data.agent);
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

    function handleAgent(agent: AgentState) {
      const cwd = professorCwdRef.current;
      if (!cwd || agent.cwd !== cwd) return;
      const text = agent.lastAssistantText?.trim();
      if (!text) return;
      // Detect a fresh turn vs. an append. If the previous text is a
      // prefix of the new one, only speak the suffix. Otherwise speak
      // the whole new turn — Claude has moved on.
      const prev = lastSpokenRef.current;
      const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
      lastSpokenRef.current = text;
      const fragment = delta.trim();
      if (!fragment) return;
      // eslint-disable-next-line no-console
      console.log("[TTS]", JSON.stringify(fragment));
      voiceService.speak(fragment);
    }
  }, []);

  // Listen for new Professor spawns so we know which cwd to look for in
  // the SSE stream + reset our state.
  useEffect(() => {
    const handler = ({ cwd }: { ptyId: string; cwd: string }) => {
      professorCwdRef.current = cwd;
      lastSpokenRef.current = "";
      voiceService.cancel();
    };
    uiBus.on("professor_spawned", handler);
    return () => uiBus.off("professor_spawned", handler);
  }, []);

  return null;
}
