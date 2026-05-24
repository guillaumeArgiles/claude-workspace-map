/**
 * useProfessor — hook React pour le dialogue streaming avec le Professeur.
 *
 * Gère l'historique côté client (max 20 échanges) et streame les réponses
 * chunk par chunk depuis POST /api/professor.
 *
 * Usage :
 *   const { messages, send, thinking, reset } = useProfessor();
 */

import { useCallback, useRef, useState } from "react";

export interface ProfessorMessage {
  role: "user" | "assistant";
  content: string;
}

export interface UseProfessorReturn {
  /** Historique complet de la conversation (user + assistant). */
  messages: ProfessorMessage[];
  /** Envoyer un message utilisateur et streamer la réponse. */
  send: (text: string) => Promise<void>;
  /** True pendant qu'une réponse est en cours de streaming. */
  thinking: boolean;
  /** Réinitialiser la conversation (nouveau sujet). */
  reset: () => void;
}

const MAX_HISTORY = 20;

export function useProfessor(): UseProfessorReturn {
  const [messages, setMessages] = useState<ProfessorMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  // Ref to abort an in-flight stream when the user resets mid-response.
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (text: string) => {
    if (thinking) return;

    const userMsg: ProfessorMessage = { role: "user", content: text.trim() };

    // Append user message immediately.
    setMessages((prev) => {
      const next = [...prev, userMsg].slice(-MAX_HISTORY);
      return next;
    });
    setThinking(true);

    // Snapshot current history + new user message for the request.
    const historyForRequest = (await new Promise<ProfessorMessage[]>((resolve) => {
      setMessages((prev) => { resolve(prev); return prev; });
    }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/professor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historyForRequest }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      // Append an empty assistant message and stream chunks into it.
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const event = JSON.parse(raw) as
              | { chunk: string }
              | { done: boolean }
              | { error: string };

            if ("chunk" in event) {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === "assistant") {
                  next[next.length - 1] = {
                    ...last,
                    content: last.content + event.chunk,
                  };
                }
                return next;
              });
            } else if ("error" in event) {
              const msg = event.error === "no_api_key"
                ? "Je ne suis pas disponible — configure ta clef ANTHROPIC_API_KEY pour m'activer."
                : "Une erreur est survenue, réessaie.";
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === "assistant") {
                  next[next.length - 1] = { ...last, content: msg };
                }
                return next;
              });
              console.error("Professor error:", event.error);
            }
          } catch {
            // Malformed SSE line — skip.
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("Professor fetch failed:", err);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Désolé, je ne suis pas disponible pour l'instant.",
          },
        ]);
      }
    } finally {
      abortRef.current = null;
      setThinking(false);
    }
  }, [thinking]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setThinking(false);
  }, []);

  return { messages, send, thinking, reset };
}
