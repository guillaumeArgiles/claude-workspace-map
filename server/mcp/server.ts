/**
 * Configuration du MCP server qui expose les capacités de Claude Workspace Map
 * sous forme de tools MCP standardisés.
 *
 * Pour le spike (étape 1 de la roadmap), un seul tool : `list_agents`.
 * Les tools de manipulation (spawn, send_message, kill) arrivent à l'impl
 * complète (TB.7.B).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listAgents } from "./bridge.js";

const SERVER_INFO = {
  name: "claude-workspace-map",
  version: "0.1.0",
} as const;

/**
 * Crée et retourne une instance McpServer prête à être branchée à un transport
 * (stdio ou HTTP). Exportée séparément pour faciliter les tests.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "list_agents",
    {
      title: "List active Claude agents",
      description:
        "Liste les sessions Claude Code actuellement actives dans FleetView. " +
        "Retourne sessionId, projectName, cwd, status, tool en cours.",
    },
    async () => {
      const agents = await listAgents();
      // Trim down to the fields most useful for an orchestrator agent —
      // raw AgentState has lots of internal fields that aren't relevant here.
      const summary = agents.map((a) => ({
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
      }));
      return {
        content: [
          { type: "text", text: JSON.stringify(summary, null, 2) },
        ],
      };
    }
  );

  return server;
}
