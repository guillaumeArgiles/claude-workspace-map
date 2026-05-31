import { useEffect, useRef } from "react";
import { uiBus } from "../game/services/uiBus";
import { voiceService } from "../services/voiceService";
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

      const es = new EventSource(
        `/api/sessions/${encodeURIComponent(ptyId)}/output`
      );
      eventSourceRef.current = es;

      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as { chunk?: string };
          const chunk = data.chunk ?? "";
          if (!chunk) return;
          const clean = stripAnsi(chunk);
          if (clean) voiceService.speak(clean);
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

// ── ANSI stripping ───────────────────────────────────────────────────────────

/**
 * Removes the ANSI escape sequences emitted by Claude Code's TUI (cursor
 * positioning, colours, bracketed paste mode, OSC titles, etc.) so the
 * resulting text reads naturally to a TTS engine.
 *
 * Patterns covered :
 * - CSI sequences  : `\x1b[…<letter>`
 * - OSC sequences  : `\x1b]…(BEL|ST)`
 * - Bracketed paste mode markers and other ESC-prefixed escapes
 * - Lone control characters (BEL, BS, CR alone, etc.)
 *
 * Implemented as a tight regex pipeline rather than depending on the
 * `strip-ansi` npm package — keeps the bundle slim and lets us tune the
 * filtering for our specific PTY output.
 */
export function stripAnsi(input: string): string {
  return input
    // CSI : ESC [ params/intermediates letter
    .replace(/\x1b\[[0-9;?<>= ]*[A-Za-z]/g, "")
    // OSC : ESC ] ... BEL/ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Other ESC-prefixed two-char sequences (e.g. ESC > , ESC = , ESC (B)
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[>=]/g, "")
    // Lone control chars (BEL, BS, FF, SO, SI, CR alone)
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "");
}
