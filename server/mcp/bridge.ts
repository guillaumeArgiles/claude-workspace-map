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

/** Erreur typée pour les réponses HTTP non-2xx (qu'on veut distinguer du réseau down). */
export class FleetViewHttpError extends Error {
  constructor(public status: number, public payload: unknown) {
    super(`FleetView responded ${status}: ${JSON.stringify(payload)}`);
    this.name = "FleetViewHttpError";
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new FleetViewUnreachableError(err);
  }
  // 204 No Content has no body — return undefined cast as T.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? safeJson(text) : undefined;
  if (!res.ok) throw new FleetViewHttpError(res.status, json ?? text);
  return json as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** GET /api/state — snapshot complet des agents actifs. */
export async function listAgents(): Promise<AgentState[]> {
  const payload = await request<{ agents: AgentState[] }>("GET", "/api/state");
  return payload.agents;
}

/** Find a single agent in the snapshot, or null if absent. */
export async function getAgent(sessionId: string): Promise<AgentState | null> {
  const agents = await listAgents();
  return agents.find((a) => a.sessionId === sessionId) ?? null;
}

/**
 * Résout un Claude `sessionId` (UUID) en `ptyId` interne (notre id court).
 * Le mapping est entretenu côté serveur par le JSONL watcher quand une
 * session démarre.
 *
 * Retourne null si la session n'a pas (encore) été liée à un PTY :
 * - session externe (ex : lancée à la main dans un terminal hors FleetView)
 * - session fraîchement spawnée, link pas encore propagé
 */
export async function resolveSessionIdToPtyId(
  sessionId: string
): Promise<string | null> {
  const { ptyId } = await request<{ ptyId: string | null }>(
    "GET",
    `/api/sessions/by-session/${encodeURIComponent(sessionId)}`
  );
  return ptyId;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** POST /api/sessions — spawne un PTY Claude dans le cwd donné. */
export async function spawnSession(cwd: string): Promise<{ ptyId: string }> {
  return await request<{ ptyId: string }>("POST", "/api/sessions", { cwd });
}

/** POST /api/sessions/:ptyId/write — pousse du texte dans le PTY. */
export async function writeToSession(
  ptyId: string,
  text: string
): Promise<void> {
  await request<{ ok: boolean }>(
    "POST",
    `/api/sessions/${encodeURIComponent(ptyId)}/write`,
    { text }
  );
}

/** DELETE /api/sessions/:ptyId — termine la session PTY. */
export async function killSession(ptyId: string): Promise<void> {
  await request<{ ok: boolean }>(
    "DELETE",
    `/api/sessions/${encodeURIComponent(ptyId)}`
  );
}
