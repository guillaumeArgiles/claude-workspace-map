import http from "node:http";
import { SessionWatcher } from "./watcher.js";
import type { ServerEvent, AgentState } from "../shared/agent-types.js";

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

const server = http.createServer((req, res) => {
  const url = req.url ?? "";
  // CORS for vite dev server on a different origin (in practice we proxy, but be safe).
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
    // Initial snapshot so a freshly-connected client sees current state.
    res.write(
      `data: ${JSON.stringify({ type: "snapshot", agents: watcher.list() } satisfies ServerEvent)}\n\n`
    );
    req.on("close", () => sseClients.delete(res));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, async () => {
  await watcher.start();
  console.log(`[server] http://localhost:${PORT}`);
  console.log(`[server] GET /api/state   — current snapshot`);
  console.log(`[server] GET /api/events  — SSE stream`);
});

const shutdown = async () => {
  console.log("[server] shutting down…");
  await watcher.stop();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
