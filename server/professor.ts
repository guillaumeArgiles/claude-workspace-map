/**
 * Le Professeur — orchestrateur IA du workspace.
 *
 * Un NPC spécial sur la map dont le rôle est d'optimiser le temps de
 * l'utilisateur pendant que ses agents Claude Code travaillent.
 *
 * Architecture :
 * - L'historique de conversation est géré CÔTÉ CLIENT (envoyé dans chaque requête).
 *   Le serveur est stateless — plus simple, pas de fuite mémoire, pas de session.
 * - Les réponses sont streamées via SSE (chunk par chunk) pour un effet "parole" naturel.
 * - Le snapshot des agents est injecté dans le system prompt à chaque tour.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentState } from "../shared/agent-types.js";
import { child } from "./logger.js";

const log = child("professor");

/** True if the API key is available — used to give a clear UX error instead of a crash. */
export const professorAvailable = !!process.env.ANTHROPIC_API_KEY;

const client = professorAvailable ? new Anthropic() : null;

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `Tu es le Professeur, l'orchestrateur stratégique de Claude Workspace Map.
Tu observes en temps réel toutes les sessions Claude Code actives de l'utilisateur
et ton rôle est d'optimiser son temps pendant que ses agents travaillent.

## Ton caractère
Mentor bienveillant mais direct. Tu vas à l'essentiel. Tu ne parles pas pour ne rien dire.
Tu poses une question ou tu proposes une action concrète — jamais les deux en même temps.
Tu tutoies l'utilisateur. Tes réponses sont courtes par défaut (3-6 lignes), l'utilisateur peut demander plus.

## Ce que tu vois (snapshot live des agents)
<agents>
{{AGENTS_SNAPSHOT}}
</agents>

Format : [projet] statut · outil — détail
Statuts : planning, coding, running_tool, awaiting_approval, idle, done, blocked.

## Tes priorités dans cet ordre
1. Si un agent est \`awaiting_approval\` ou \`blocked\` → signale-le en premier, c'est urgent.
2. Si tous les agents codent tranquillement → propose du travail de fond à l'utilisateur.
3. Si des agents sont \`idle\` ou \`done\` → suggère de nouveaux chantiers à lancer.

## Activités que tu proposes (adapte au contexte)
- **Préparation de réunion** — agenda structuré, points clés, questions à préparer
- **Affinage de ticket** — transformer une idée vague en user story avec critères d'acceptance
- **Questions métier** — architecture, priorisation, décisions produit, arbitrages techniques
- **Rédaction de CLAUDE.md** — documenter un projet pour qu'un agent y travaille mieux
- **Revue de plan** — analyser et challenger un plan avant de le soumettre à un agent
- **Stratégie** — roadmap, backlog, risques, préparation d'un pitch ou d'une démo
- **Documentation** — ADRs, changelogs, READMEs, specs techniques, post-mortems

## Règles de réponse
- Si tu proposes une activité, donne immédiatement la première question concrète.
  Pas "on pourrait préparer une réunion" → mais "Pour quelle réunion ? Donne-moi le contexte en 2 lignes."
- Maximum une question par message.
- Si l'utilisateur dit qu'il a du temps libre → propose 2-3 options courtes, il choisit.
- Si des agents sont en attente, commence TOUJOURS par ça avant de proposer autre chose.

## Ce que tu n'es pas
- Tu n'es pas un agent qui code. Tu ne génères pas de code.
- Tu n'exécutes pas de commandes. Tu réfléchis, structures, challenges.
- Tu n'es pas un assistant généraliste — tu restes dans le périmètre du travail en cours.`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfessorMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProfessorRequest {
  messages: ProfessorMessage[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a concise text snapshot of all active agents for the system prompt. */
export function buildAgentsSnapshot(agents: AgentState[]): string {
  if (agents.length === 0) return "Aucun agent actif.";
  return agents
    .map((a) => {
      let line = `[${a.projectName}] ${a.status}`;
      if (a.currentTool) line += ` · ${a.currentTool}`;
      if (a.currentToolDetail) line += ` — ${a.currentToolDetail}`;
      return line;
    })
    .join("\n");
}

/** Build the system prompt with the live agents snapshot injected. */
function buildSystemPrompt(agents: AgentState[]): string {
  return SYSTEM_PROMPT_TEMPLATE.replace(
    "{{AGENTS_SNAPSHOT}}",
    buildAgentsSnapshot(agents)
  );
}

/** Validate and sanitise incoming messages (max 20 turns to bound token cost). */
function sanitiseHistory(messages: ProfessorMessage[]): Anthropic.MessageParam[] {
  return messages
    .slice(-20)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => typeof m.content === "string" && m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content.trim() }));
}

// ── Streaming handler ─────────────────────────────────────────────────────────

/**
 * Stream a professor response.
 *
 * Writes SSE events to `write`:
 *   data: {"chunk":"..."}\n\n   — one per text delta
 *   data: {"done":true}\n\n     — end of stream
 *   data: {"error":"..."}\n\n   — on failure
 */
export async function streamProfessorResponse(
  request: ProfessorRequest,
  agents: AgentState[],
  write: (data: string) => void
): Promise<void> {
  const messages = sanitiseHistory(request.messages);

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    write(`data: ${JSON.stringify({ error: "Last message must be from user" })}\n\n`);
    return;
  }

  if (!client) {
    write(`data: ${JSON.stringify({ error: "no_api_key" })}\n\n`);
    return;
  }

  try {
    const stream = await client.messages.stream({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: buildSystemPrompt(agents),
      messages,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        write(`data: ${JSON.stringify({ chunk: event.delta.text })}\n\n`);
      }
    }

    write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    log.error({ err }, "professor stream error");
    write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
  }
}
