import http from "node:http";
import { SessionWatcher } from "./watcher.js";
import { child } from "./logger.js";
import type { ServerEvent, AgentState } from "../shared/agent-types.js";

const log = child("server");

const PORT = Number(process.env.PORT ?? 4000);

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

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, async () => {
  await watcher.start();
  log.info(
    {
      port: PORT,
      endpoints: ["GET /api/state", "GET /api/events", "POST /api/hook"],
    },
    "server up"
  );
});

const shutdown = async () => {
  log.info("server shutting down…");
  await watcher.stop();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
