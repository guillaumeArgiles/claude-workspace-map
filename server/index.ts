import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { SessionWatcher } from "./watcher.js";
import { child } from "./logger.js";
import { setValidationErrorSink } from "./parser.js";
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

  await watcher.start();

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
    await watcher.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
