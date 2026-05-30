/**
 * Entry point standalone du MCP server.
 *
 * Lancé en stdio par un client MCP (ex : Claude Code via `~/.claude.json`).
 * Le binaire est `tsx server/mcp/main.ts` en dev, ou pourra être compilé
 * vers un script Node tout court à la fin du chantier MCP.
 *
 * Le MCP server ne démarre pas le serveur HTTP — il s'attend à ce que l'app
 * FleetView tourne déjà (Electron ou `npm run dev`).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Pas de log stdout — stdio est réservé au protocole MCP. Erreurs sur stderr.
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[mcp] fatal:", err);
  process.exit(1);
});
