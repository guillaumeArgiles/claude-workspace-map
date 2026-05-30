/**
 * Bridge HTTP entre le MCP server et le serveur principal Claude Workspace Map.
 *
 * Le MCP server tourne en process séparé (lancé en stdio par le client MCP, par
 * exemple Claude Code). Pour exposer les agents et les sessions PTY, il parle au
 * serveur HTTP de l'app (Electron ou `npm run server`) via les endpoints REST
 * déjà existants — zero refactor du serveur principal.
 *
 * Prérequis : l'app FleetView doit tourner sur `FLEETVIEW_PORT` (default 4000).
 */

import type { AgentState } from "../../shared/agent-types.js";

const PORT = Number(process.env.FLEETVIEW_PORT ?? 4000);
const BASE = `http://localhost:${PORT}`;

/** Erreur typée quand l'app FleetView n'est pas joignable. */
export class FleetViewUnreachableError extends Error {
  constructor(cause: unknown) {
    super(
      `Cannot reach FleetView server at ${BASE}. ` +
        `Is the app running? (npm run dev / open the Electron app)\n` +
        `Cause: ${String(cause)}`
    );
    this.name = "FleetViewUnreachableError";
  }
}

async function getJson<T>(path: string): Promise<T> {
  try {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    throw new FleetViewUnreachableError(err);
  }
}

/** GET /api/state — snapshot complet des agents actifs. */
export async function listAgents(): Promise<AgentState[]> {
  const payload = await getJson<{ agents: AgentState[] }>("/api/state");
  return payload.agents;
}
