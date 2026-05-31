import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SessionWatcher } from "./watcher.js";
import { child } from "./logger.js";
import { setValidationErrorSink } from "./parser.js";
import { ptyManager } from "./pty-manager.js";
import { spawnProfessor, PROFESSOR_DIR } from "./professor.js";
import { readConfig, writeConfig } from "./config-store.js";
import { aggregateStats } from "./stats-aggregator.js";
import { createMcpServer } from "./mcp/server.js";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  listRoutines,
  updateRoutine,
} from "./routines-store.js";
import {
  nextRunAtFor,
  startRoutinesScheduler,
  stopRoutinesScheduler,
} from "./routines-scheduler.js";
import { listNativeRoutines } from "./native-routines.js";
import type { ServerEvent, AgentState } from "../shared/agent-types.js";

/** MIME types for static file serving (renderer assets in prod). */
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".css":  "text/css",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".json": "application/json",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
};

const log = child("server");
const parserLog = child("parser");

// Surface JSONL lines that fail Zod validation. Sampled at debug level: a busy
// session can produce a lot, and the parser is tolerant — we just want a
// signal when Claude Code's format drifts.
setValidationErrorSink((reason, raw) => {
  parserLog.debug({ reason, raw }, "jsonl line failed validation");
});

/**
 * Start the HTTP server on the given port.
 *
 * Returns a `stop()` function that gracefully shuts down the server and
 * the JSONL watcher.
 *
 * Called by:
 * - `electron/main.ts` (Electron app) — on app ready
 * - `server/start.ts` (standalone dev) — via `npm run server`
 */
/**
 * @param port      HTTP port to listen on.
 * @param staticRoot  Optional path to a directory of static files to serve
 *                    (used in Electron production to serve dist/ over HTTP so
 *                    that Phaser's XHR loader and React API calls resolve to
 *                    localhost instead of broken file:// paths inside the ASAR).
 */
export async function startServer(
  port: number,
  staticRoot?: string
): Promise<() => Promise<void>> {
  const sseClients = new Set<http.ServerResponse>();

  function broadcast(event: ServerEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  const watcher = new SessionWatcher({
    onSpawn(agent: AgentState) {
      // Link new Claude session to the PTY that spawned it (same cwd, no session yet,
      // started within 5 min of each other).
      const unlinked = ptyManager
        .list()
        .find(
          (p) =>
            p.cwd === agent.cwd &&
            !p.sessionId &&
            Math.abs(p.createdAt - agent.startedAt) < 300_000
        );
      if (unlinked) ptyManager.linkSession(unlinked.id, agent.sessionId);
      broadcast({ type: "agent_spawned", agent });
    },
    onUpdate(agent: AgentState) {
      broadcast({ type: "agent_updated", agent });
    },
    onRemove(sessionId: string) {
      broadcast({ type: "agent_removed", sessionId });
    },
  });

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "GET" && url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ agents: watcher.list() }));
      return;
    }

    if (req.method === "GET" && url === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sseClients.add(res);
      res.write(
        `data: ${JSON.stringify({ type: "snapshot", agents: watcher.list() } satisfies ServerEvent)}\n\n`
      );
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // ── PTY / session control ─────────────────────────────────────────────

    // POST /api/sessions — spawn a new Claude session in the given cwd
    if (req.method === "POST" && url === "/api/sessions") {
      let body = "";
      try {
        for await (const chunk of req) body += chunk;
        const { cwd, command } = JSON.parse(body) as { cwd: string; command?: string };
        if (!cwd) throw new Error("cwd is required");
        const ptyId = ptyManager.spawn(cwd, command);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ptyId }));
      } catch (err) {
        const msg = String(err);
        // Detect PTY exhaustion (macOS kern.tty.ptmx_max hit — usually caused by a
        // PTY file-descriptor leak in Claude Code holding all 511 slots).
        const isPtyExhausted = msg.includes("posix_spawnp") || msg.includes("out of pty");
        log.warn({ err, isPtyExhausted }, "POST /api/sessions error");
        res.writeHead(isPtyExhausted ? 503 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: isPtyExhausted
            ? "System PTY limit reached (kern.tty.ptmx_max=511). Restart the Claude app to free leaked PTY file descriptors."
            : msg,
        }));
      }
      return;
    }

    // POST /api/sessions/:ptyId/write — send text input to a running PTY
    const writeMatch = url.match(/^\/api\/sessions\/([^/]+)\/write$/);
    if (req.method === "POST" && writeMatch) {
      const ptyId = writeMatch[1];
      let body = "";
      try {
        for await (const chunk of req) body += chunk;
        const { text } = JSON.parse(body) as { text: string };
        const ok = ptyManager.write(ptyId, text ?? "");
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/sessions/:ptyId/output — SSE stream of raw PTY output
    const outputMatch = url.match(/^\/api\/sessions\/([^/]+)\/output$/);
    if (req.method === "GET" && outputMatch) {
      const ptyId = outputMatch[1];
      const session = ptyManager.get(ptyId);
      if (!session) {
        res.writeHead(404);
        res.end("PTY session not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // Replay buffered output so the UI doesn't miss anything on connect.
      if (session.outputBuffer) {
        res.write(`data: ${JSON.stringify({ chunk: session.outputBuffer })}\n\n`);
      }
      const listener = (chunk: string) => {
        try {
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        } catch {
          session.listeners.delete(listener);
        }
      };
      session.listeners.add(listener);
      req.on("close", () => session.listeners.delete(listener));
      return;
    }

    // POST /api/sessions/:ptyId/resize — sync PTY dimensions with xterm.js FitAddon
    const resizeMatch = url.match(/^\/api\/sessions\/([^/]+)\/resize$/);
    if (req.method === "POST" && resizeMatch) {
      const ptyId = resizeMatch[1];
      let body = "";
      try {
        for await (const chunk of req) body += chunk;
        const { cols, rows } = JSON.parse(body) as { cols: number; rows: number };
        const ok = ptyManager.resize(ptyId, cols, rows);
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // GET /api/sessions/by-session/:sessionId — resolve ptyId from Claude sessionId
    const bySessionMatch = url.match(/^\/api\/sessions\/by-session\/([^/]+)$/);
    if (req.method === "GET" && bySessionMatch) {
      const sessionId = decodeURIComponent(bySessionMatch[1]);
      const found = ptyManager.list().find((s) => s.sessionId === sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ptyId: found?.id ?? null }));
      return;
    }

    // GET /api/sessions — list active PTY sessions
    if (req.method === "GET" && url === "/api/sessions") {
      const list = ptyManager.list().map(({ id, cwd, pid, sessionId, createdAt, exitCode }) => ({
        id, cwd, pid, sessionId, createdAt, exitCode,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    // DELETE /api/agents/:sessionId — dismiss one agent from the sidebar
    const agentDeleteMatch = url.match(/^\/api\/agents\/([^/]+)$/);
    if (req.method === "DELETE" && agentDeleteMatch) {
      watcher.dismiss(agentDeleteMatch[1]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // DELETE /api/agents — bulk dismiss done/idle agents
    if (req.method === "DELETE" && url === "/api/agents") {
      watcher.dismissWhere((a) => a.status === "done" || a.status === "idle");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // DELETE /api/sessions/:ptyId — kill a PTY
    const deleteMatch = url.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      const ok = ptyManager.kill(deleteMatch[1]);
      res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok }));
      return;
    }

    // POST /api/professor/spawn — crée le CLAUDE.md avec le snapshot agents
    // et spawne une session Claude Code dans le dossier dédié du Professeur.
    // Retourne { ptyId, cwd } comme POST /api/sessions.
    if (req.method === "POST" && url === "/api/professor/spawn") {
      try {
        const ptyId = await spawnProfessor(watcher.list());
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ptyId, cwd: PROFESSOR_DIR }));
      } catch (err) {
        log.warn({ err }, "POST /api/professor/spawn error");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url === "/api/hook") {
      let body = "";
      try {
        for await (const chunk of req) body += chunk;
        const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        watcher.applyHookEvent(payload);
        res.writeHead(204);
        res.end();
      } catch (err) {
        log.warn({ err }, "/api/hook bad payload");
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad JSON");
      }
      return;
    }

    // ── Local insights dashboard ─────────────────────────────────────────
    // Aggregates Claude Code JSONL transcripts on demand. No persistence,
    // no caching for v1; ~50 files / 100 MB scans in well under a second.
    if (req.method === "GET" && url.startsWith("/api/stats")) {
      try {
        const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
        const params = new URLSearchParams(qs);
        const fromStr = params.get("from");
        const toStr = params.get("to");
        const projectCwd = params.get("projectCwd") ?? undefined;
        const from = fromStr ? Date.parse(fromStr) : undefined;
        const to = toStr ? Date.parse(toStr) : undefined;
        const stats = await aggregateStats({
          from: Number.isFinite(from) ? from : undefined,
          to: Number.isFinite(to) ? to : undefined,
          projectCwd,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stats));
      } catch (err) {
        log.warn({ err }, "/api/stats failed");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // ── App config ───────────────────────────────────────────────────────
    if (req.method === "GET" && url === "/api/config") {
      const config = await readConfig();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(config));
      return;
    }

    if (req.method === "PUT" && url === "/api/config") {
      let body = "";
      try {
        for await (const chunk of req) body += chunk;
        const updated = await writeConfig(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(updated));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // ── FleetView routines — CRUD over ~/.claude-workspace-map/routines.json ──
    // Read-only Claude-native routines are appended at GET /api/routines as
    // a `native` array (added in phase 2).

    if (req.method === "GET" && url === "/api/routines") {
      try {
        // FleetView store + Claude-native sources, read in parallel.
        const [fleet, native] = await Promise.all([
          listRoutines(),
          listNativeRoutines(),
        ]);
        const fleetWithNext = fleet.map((r) => ({ ...r, nextRunAt: nextRunAtFor(r) }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ fleet: fleetWithNext, native }));
      } catch (err) {
        log.warn({ err }, "GET /api/routines failed");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url === "/api/routines") {
      let body = "";
      try {
        for await (const chunk of req) body += chunk;
        const input = body ? JSON.parse(body) : {};
        const routine = await createRoutine(input);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...routine, nextRunAt: nextRunAtFor(routine) }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    const routineByIdMatch = url.match(/^\/api\/routines\/([^/?]+)$/);
    if (req.method === "GET" && routineByIdMatch) {
      const id = decodeURIComponent(routineByIdMatch[1]);
      const routine = await getRoutine(id);
      if (!routine) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...routine, nextRunAt: nextRunAtFor(routine) }));
      return;
    }

    if (req.method === "PUT" && routineByIdMatch) {
      const id = decodeURIComponent(routineByIdMatch[1]);
      let body = "";
      try {
        for await (const chunk of req) body += chunk;
        const patch = body ? JSON.parse(body) : {};
        const updated = await updateRoutine(id, patch);
        if (!updated) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...updated, nextRunAt: nextRunAtFor(updated) }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === "DELETE" && routineByIdMatch) {
      const id = decodeURIComponent(routineByIdMatch[1]);
      const ok = await deleteRoutine(id);
      res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok }));
      return;
    }

    // ── MCP server (streamable HTTP transport, stateless) ───────────────
    // Expose les tools FleetView au standard Model Context Protocol. Tout
    // client MCP (Claude Code, Claude Desktop, etc.) peut s'y brancher via
    // `{ "url": "http://localhost:PORT/mcp" }` dans son config — pas de
    // subprocess à lancer, pas de path à dériver.
    //
    // Stateless mode : une instance fresh par requête, pas de session
    // continuity. Suffisant pour Claude Code (chaque tool call est
    // indépendant) et plus simple à raisonner.
    if (req.method === "POST" && url === "/mcp") {
      let body = "";
      try {
        for await (const chunk of req) body += chunk;
        const parsedBody = body ? JSON.parse(body) : undefined;
        const mcpServer = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
        res.on("close", () => {
          transport.close().catch(() => {});
          mcpServer.close().catch(() => {});
        });
      } catch (err) {
        log.warn({ err }, "/mcp request failed");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: String(err) },
              id: null,
            })
          );
        }
      }
      return;
    }

    // ── Static file serving (Electron production only) ──────────────────
    // In dev, Vite handles this. In Electron prod, we serve dist/ over HTTP
    // so Phaser's XHR loader and the React API calls both hit localhost:PORT
    // instead of broken file:// paths inside the ASAR.
    if (req.method === "GET" && staticRoot) {
      // Strip query string, resolve to staticRoot, prevent path traversal
      const filePath = url.split("?")[0];
      const safePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
      // "/" → index.html, everything else → literal path
      const target = safePath === "/" ? "index.html" : safePath.replace(/^\//, "");
      const full = path.join(staticRoot, target);
      const ext = path.extname(full);
      const mime = MIME[ext] ?? "application/octet-stream";
      try {
        const data = fs.readFileSync(full);
        res.writeHead(200, { "Content-Type": mime });
        res.end(data);
      } catch {
        // File not found — fall through to SPA fallback (index.html)
        try {
          const data = fs.readFileSync(path.join(staticRoot, "index.html"));
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(data);
        } catch {
          res.writeHead(404);
          res.end("Not found");
        }
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // Persist the actual port so the settings UI can display it.
  readConfig().then((cfg) => writeConfig({ ...cfg, port })).catch(() => {});

  await watcher.start();
  startRoutinesScheduler();

  log.info(
    {
      port,
      endpoints: ["GET /api/state", "GET /api/events", "POST /api/hook"],
    },
    "server up"
  );

  return async () => {
    log.info("server shutting down…");
    for (const client of sseClients) {
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    stopRoutinesScheduler();
    await watcher.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
