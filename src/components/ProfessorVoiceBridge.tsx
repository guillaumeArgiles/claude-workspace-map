import { useEffect, useRef } from "react";
import { uiBus } from "../game/services/uiBus";
import { voiceService } from "../services/voiceService";
import { VoiceTextFilter } from "../services/voiceTextFilter";
import type { Locale } from "../../shared/config-schema";

/**
 * Headless component that bridges Le Professeur's PTY output stream to the
 * Web-Speech-API-powered voice service.
 *
 * Listens for `professor_spawned` on the uiBus (fired by AgentSidebar after
 * each successful POST /api/professor/spawn). For each spawn, opens an SSE
 * connection to `/api/sessions/:ptyId/output`, strips ANSI escape sequences
 * from each chunk, and feeds the cleaned text to `voiceService.speak()`,
 * which idle-debounces fragments into natural utterances.
 *
 * Pure side-effect : renders nothing. Mounted once at the App root so it
 * lives for the whole session regardless of which Phaser scene is active.
 *
 * `enabled` and `locale` follow the user's AppConfig — toggled via the
 * Settings panel. The component pipes those through to the voice service
 * so it stays in sync.
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

  // Active EventSource for whichever Professor PTY is current. Closing the
  // previous one is critical — without it a new spawn would pile streams.
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    function attachToPty(ptyId: string) {
      // Close any prior stream before re-attaching.
      eventSourceRef.current?.close();
      voiceService.cancel(); // drop in-flight speech from the previous spawn

      // Filter strips ANSI + TUI chrome + code blocks + file paths from the
      // PTY stream so only the Professor's actual prose reaches the TTS
      // engine. Resets on every new attach so we don't carry over half-
      // parsed code-block state.
      const filter = new VoiceTextFilter();

      const es = new EventSource(
        `/api/sessions/${encodeURIComponent(ptyId)}/output`
      );
      eventSourceRef.current = es;

      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as { chunk?: string };
          const chunk = data.chunk ?? "";
          if (!chunk) return;
          const spoken = filter.feed(chunk);
          if (spoken) voiceService.speak(spoken);
        } catch {
          /* malformed event — skip */
        }
      };

      es.onerror = () => {
        // SSE auto-reconnects on transient errors. Nothing for us to do here
        // unless we want to surface a UI hint, which is overkill for TTS.
      };
    }

    const handler = ({ ptyId }: { ptyId: string; cwd: string }) => {
      attachToPty(ptyId);
    };

    uiBus.on("professor_spawned", handler);
    return () => {
      uiBus.off("professor_spawned", handler);
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      voiceService.cancel();
    };
  }, []);

  return null;
}

// stripAnsi + the line-level filter now live in src/services/voiceTextFilter.ts
// so they can be unit-tested in isolation and reused outside this component.
