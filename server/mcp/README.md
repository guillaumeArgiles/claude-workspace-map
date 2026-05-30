# Claude Workspace Map — MCP server

Expose les capacités de FleetView (lister/contrôler les agents Claude actifs) à
n'importe quel client MCP via le standard [Model Context Protocol](https://modelcontextprotocol.io).

## Statut

- **Spike** ✅ — `list_agents` opérationnel (étape 1 de la roadmap MCP, cf [BACKLOG.md](../../docs/BACKLOG.md))
- **Impl complète** à venir : `spawn_agent`, `send_message`, `kill_agent`
- **Wire Professeur** à venir : remplacer les `pty.write` directs par des appels MCP

## Architecture

```
┌─────────────┐    stdio JSON-RPC    ┌─────────────────┐    HTTP REST    ┌─────────────────┐
│ MCP client  │ ───────────────────► │  MCP server     │ ──────────────► │ FleetView HTTP  │
│ (Claude     │                      │  (tsx process)  │                 │ server (Electron│
│  Code)      │ ◄─────────────────── │  server/mcp/*   │ ◄────────────── │  ou npm run dev)│
└─────────────┘    JSON-RPC reply    └─────────────────┘    JSON         └─────────────────┘
```

Le MCP server est un **bridge léger** : il ne maintient aucun state, il
forward chaque appel vers le serveur HTTP principal qui, lui, possède le
watcher JSONL + le PTY manager.

Avantages :
- Aucun refactor du serveur HTTP
- Le MCP server est minuscule (~50 lignes utiles)
- Si l'app FleetView n'est pas lancée, erreur claire (`FleetViewUnreachableError`)

## Lancer en standalone

```bash
npm run mcp
```

Lit JSON-RPC sur stdin, écrit sur stdout (silence sur stderr sauf erreur).

## Brancher dans Claude Code

Ajoute ceci dans `~/.claude.json` (ou via `claude mcp add` si disponible) :

```json
{
  "mcpServers": {
    "claude-workspace-map": {
      "command": "npx",
      "args": ["tsx", "/Applications/MAMP/htdocs/map/server/mcp/main.ts"],
      "env": {
        "FLEETVIEW_PORT": "4000"
      }
    }
  }
}
```

Au prochain démarrage de Claude Code, les tools du MCP server sont disponibles
sous le préfixe `mcp__claude-workspace-map__list_agents` (et autres à venir).

## Tools disponibles

| Tool | Description | Inputs | Statut |
|---|---|---|---|
| `list_agents` | Snapshot des sessions Claude Code actives | aucun | ✅ spike |
| `spawn_agent` | Lance une nouvelle session Claude dans un cwd | `cwd`, `prompt?` | ⏳ TB.7.B |
| `send_message` | Écrit du texte dans un PTY existant | `sessionId`, `text` | ⏳ TB.7.B |
| `kill_agent` | Termine une session | `sessionId` | ⏳ TB.7.B |

## Test rapide en CLI

Pendant que l'app FleetView tourne :

```bash
# Handshake + tools/list
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0.0.1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | npm run mcp --silent

# Call list_agents
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0.0.1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_agents","arguments":{}}}' \
  | npm run mcp --silent
```
