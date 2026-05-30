/**
 * Configuration du MCP server qui expose les capacités de Claude Workspace Map
 * sous forme de tools MCP standardisés.
 *
 * Tools exposés :
 * - `list_agents` ............ snapshot des sessions actives
 * - `get_agent_status` ....... détail d'une session par sessionId
 * - `spawn_agent` ............ lance une nouvelle session Claude dans un cwd
 * - `send_message` ........... écrit du texte dans une session existante
 * - `kill_agent` ............. termine une session
 *
 * Chaque tool est un wrapper mince autour du bridge HTTP — pas de state local,
 * pas de logique métier dupliquée. Cf [server/mcp/bridge.ts](./bridge.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as bridge from "./bridge.js";
import type { AgentState } from "../../shared/agent-types.js";

const SERVER_INFO = {
  name: "claude-workspace-map",
  version: "0.1.0",
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Texte content standard pour les retours JSON. */
function jsonContent(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/** Tool error result — propagé au client MCP avec isError: true. */
function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

/**
 * Wrappe un handler pour catcher les exceptions et les transformer en tool
 * error result lisible par un LLM (au lieu de remonter une exception brute
 * via le protocole JSON-RPC).
 */
function safeHandler<T>(
  handler: (input: T) => Promise<ReturnType<typeof jsonContent>>
) {
  return async (input: T) => {
    try {
      return await handler(input);
    } catch (err) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  };
}

/** Compact summary used by list_agents (full AgentState contains noise). */
function summarizeAgent(a: AgentState) {
  return {
    sessionId: a.sessionId,
    projectName: a.projectName,
    cwd: a.cwd,
    status: a.status,
    currentTool: a.currentTool,
    currentToolDetail: a.currentToolDetail,
    startedAt: new Date(a.startedAt).toISOString(),
    lastActivityAt: new Date(a.lastActivityAt).toISOString(),
    subAgentCount: a.subAgents.length,
    hasPendingApproval:
      Boolean(a.pendingPlan) || Boolean(a.pendingQuestions?.length),
  };
}

/**
 * Résout un sessionId (Claude UUID) en ptyId (id PTY interne). Soulève une
 * erreur explicite si la session est inconnue ou non liée à un PTY (cas des
 * sessions externes lancées hors FleetView).
 */
async function requirePtyId(sessionId: string): Promise<string> {
  const ptyId = await bridge.resolveSessionIdToPtyId(sessionId);
  if (!ptyId) {
    throw new Error(
      `Session ${sessionId} is not bound to a PTY managed by FleetView. ` +
        `Only sessions spawned through FleetView (or via spawn_agent) can be controlled.`
    );
  }
  return ptyId;
}

// ── Server factory ───────────────────────────────────────────────────────────

/**
 * Crée et retourne une instance McpServer prête à être branchée à un transport
 * (stdio ou HTTP). Exportée séparément pour faciliter les tests.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

  // ── list_agents ────────────────────────────────────────────────────────────
  server.registerTool(
    "list_agents",
    {
      title: "List active Claude agents",
      description:
        "Liste les sessions Claude Code actuellement actives dans FleetView. " +
        "Retourne un résumé par session : sessionId, projectName, cwd, status, " +
        "tool en cours, dates, présence d'une approbation en attente.",
    },
    safeHandler(async () => {
      const agents = await bridge.listAgents();
      return jsonContent(agents.map(summarizeAgent));
    })
  );

  // ── get_agent_status ───────────────────────────────────────────────────────
  server.registerTool(
    "get_agent_status",
    {
      title: "Get full status of one agent",
      description:
        "Détail complet d'une session Claude par son sessionId, incluant " +
        "subAgents, plan en attente d'approbation (pendingPlan), et questions " +
        "AskUserQuestion (pendingQuestions). Retourne null si l'agent n'existe pas.",
      inputSchema: {
        sessionId: z
          .string()
          .describe("UUID Claude de la session (obtenu via list_agents)"),
      },
    },
    safeHandler(async ({ sessionId }) => {
      const agent = await bridge.getAgent(sessionId);
      return jsonContent(agent);
    })
  );

  // ── spawn_agent ────────────────────────────────────────────────────────────
  server.registerTool(
    "spawn_agent",
    {
      title: "Spawn a new Claude session",
      description:
        "Lance une nouvelle session Claude Code dans le `cwd` donné. Si `prompt` " +
        "est fourni, le texte est envoyé à la session après ~1.5s (le temps que " +
        "Claude Code finisse de booter). Retourne le ptyId interne. Le sessionId " +
        "Claude apparaîtra dans list_agents quelques secondes après le spawn.",
      inputSchema: {
        cwd: z
          .string()
          .describe("Chemin absolu du dossier où lancer la session Claude"),
        prompt: z
          .string()
          .optional()
          .describe(
            "Prompt initial envoyé à Claude après boot. Newline ajoutée automatiquement."
          ),
      },
    },
    safeHandler(async ({ cwd, prompt }) => {
      const { ptyId } = await bridge.spawnSession(cwd);
      if (prompt) {
        // Reproduit le pattern de Le Professeur : attendre que Claude soit
        // prêt avant d'envoyer le prompt initial (~1.5s).
        await new Promise((r) => setTimeout(r, 1500));
        await bridge.writeToSession(ptyId, `${prompt}\r`);
      }
      return jsonContent({ ptyId, cwd, promptSent: Boolean(prompt) });
    })
  );

  // ── send_message ───────────────────────────────────────────────────────────
  server.registerTool(
    "send_message",
    {
      title: "Send text to an existing Claude session",
      description:
        "Écrit du texte dans une session Claude existante (via son PTY). " +
        "Pour envoyer une commande qui doit s'exécuter, terminer par `\\r`. " +
        "Échoue si la session n'est pas gérée par FleetView (session externe).",
      inputSchema: {
        sessionId: z
          .string()
          .describe("UUID Claude de la session cible"),
        text: z
          .string()
          .describe(
            "Texte à écrire. Pour envoyer comme une commande, terminer par `\\r`."
          ),
      },
    },
    safeHandler(async ({ sessionId, text }) => {
      const ptyId = await requirePtyId(sessionId);
      await bridge.writeToSession(ptyId, text);
      return jsonContent({ ok: true, sessionId, ptyId, bytesWritten: text.length });
    })
  );

  // ── kill_agent ─────────────────────────────────────────────────────────────
  server.registerTool(
    "kill_agent",
    {
      title: "Terminate a Claude session",
      description:
        "Termine la session Claude (kill du PTY sous-jacent). Échoue si la " +
        "session n'est pas gérée par FleetView (session externe).",
      inputSchema: {
        sessionId: z
          .string()
          .describe("UUID Claude de la session à terminer"),
      },
    },
    safeHandler(async ({ sessionId }) => {
      const ptyId = await requirePtyId(sessionId);
      await bridge.killSession(ptyId);
      return jsonContent({ ok: true, sessionId, ptyId });
    })
  );

  return server;
}
