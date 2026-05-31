/**
 * Browser-side Text-to-Speech for Le Professeur.
 *
 * Wraps `window.speechSynthesis` (Web Speech API) with :
 * - **Idle-debounced buffering** : Claude streams text token by token over
 *   the PTY ; speaking each chunk would yield staccato robotic delivery.
 *   We accumulate fragments and flush them as one utterance after a short
 *   pause in incoming text (= a natural sentence/paragraph end).
 * - **Locale-aware voice picking** : the user's app locale (`fr` / `en` /
 *   `es`) maps to a matching synthesis voice. Falls back to the platform
 *   default when no localised voice is available.
 * - **Global enable flag** : flipped from the Settings panel. When off,
 *   `speak()` is a no-op and any in-flight queue is cancelled.
 *
 * Zero network call, zero API key — runs entirely in Chromium/Electron's
 * built-in TTS, on top of macOS / Win / Linux system voices.
 */

import type { Locale } from "../../shared/config-schema";

/** Idle window after the last fragment before we flush — tuned for Claude's
 *  token cadence (≈30-60 tokens/s with brief pauses on tool calls). 700 ms
 *  catches sentence-end pauses without breaking mid-sentence in normal flow. */
const FLUSH_IDLE_MS = 700;

/** Max single utterance size in chars. Beyond that, Chrome may stutter — we
 *  split on sentence boundaries (or hard-split if no boundary nearby). */
const MAX_UTTERANCE_CHARS = 600;

class VoiceService {
  private enabled = false;
  private locale: Locale = "fr";
  private buffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private cachedVoices: SpeechSynthesisVoice[] | null = null;

  /** Toggle voice on/off. Cancels any in-flight speech when turned off. */
  setEnabled(value: boolean): void {
    if (this.enabled === value) return;
    this.enabled = value;
    if (!value) this.cancel();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Update the preferred locale for voice selection. */
  setLocale(locale: Locale): void {
    this.locale = locale;
  }

  /**
   * Queue text to be spoken. Idempotent and buffered : repeated calls in
   * rapid succession accumulate, the actual utterance fires after
   * {@link FLUSH_IDLE_MS} of silence.
   */
  speak(text: string): void {
    if (!this.enabled) return;
    if (!supportsSpeechSynthesis()) return;
    this.buffer += text;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_IDLE_MS);
  }

  /** Force-flush the buffer right now (e.g. on session end). */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
  }

  /** Stop any current speech and drop the buffer. */
  cancel(): void {
    this.buffer = "";
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (supportsSpeechSynthesis()) {
      window.speechSynthesis.cancel();
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private flush(): void {
    this.flushTimer = undefined;
    const text = this.buffer.trim();
    this.buffer = "";
    if (!text) return;

    // Split overly long text into utterance-sized chunks.
    for (const chunk of splitForUtterance(text)) {
      this.utter(chunk);
    }
  }

  private utter(text: string): void {
    if (!supportsSpeechSynthesis()) return;
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.pickVoice();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = languageTagFor(this.locale);
    }
    u.rate = 1.0;
    u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    if (!supportsSpeechSynthesis()) return null;
    if (!this.cachedVoices || this.cachedVoices.length === 0) {
      this.cachedVoices = window.speechSynthesis.getVoices();
      // The voices list is sometimes empty on first read (Chrome quirk) —
      // re-poll lazily when needed. Subscribing to `voiceschanged` would be
      // tidier but adds wiring for a one-time read.
    }
    const langPrefix = languageTagFor(this.locale).slice(0, 2);
    const matches = this.cachedVoices.filter((v) =>
      v.lang.toLowerCase().startsWith(langPrefix)
    );
    if (matches.length === 0) return null;
    // Prefer a high-quality / local voice when available. macOS labels its
    // best French voices "Thomas", "Marie", "Amélie" — match those first.
    const PRIORITY = ["Thomas", "Amélie", "Marie", "Google", "Samantha"];
    for (const name of PRIORITY) {
      const v = matches.find((x) => x.name.includes(name));
      if (v) return v;
    }
    return matches[0]!;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function supportsSpeechSynthesis(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function languageTagFor(locale: Locale): string {
  switch (locale) {
    case "fr":
      return "fr-FR";
    case "es":
      return "es-ES";
    case "en":
    default:
      return "en-US";
  }
}

/**
 * Splits a large text block into utterance-sized fragments. Prefers
 * sentence boundaries (`. ! ? \n\n`); falls back to a hard cut at
 * {@link MAX_UTTERANCE_CHARS} when no boundary is reachable.
 */
function splitForUtterance(text: string): string[] {
  if (text.length <= MAX_UTTERANCE_CHARS) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_UTTERANCE_CHARS) {
    // Find the last sentence boundary within the limit.
    const slice = remaining.slice(0, MAX_UTTERANCE_CHARS);
    const boundary = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("? "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("\n\n")
    );
    const cut = boundary > MAX_UTTERANCE_CHARS / 2 ? boundary + 1 : MAX_UTTERANCE_CHARS;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut);
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

// ── Singleton ────────────────────────────────────────────────────────────────

export const voiceService = new VoiceService();
