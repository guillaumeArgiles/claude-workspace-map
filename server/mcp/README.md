# Claude Workspace Map — MCP server

Expose les capacités de FleetView (lister/contrôler les agents Claude actifs) à
n'importe quel client MCP via le standard [Model Context Protocol](https://modelcontextprotocol.io).

## Statut

- **Spike** ✅ — `list_agents` opérationnel
- **Impl complète** ✅ — 5 tools : list, get_status, spawn, send_message, kill (13 specs vitest sur le bridge)
- **Wire Professeur** ✅ — `server/professor.ts` écrit un `.mcp.json` dans le dossier du Professeur au moment du spawn, avec le port FleetView courant injecté. Le Professeur peut maintenant lire ET piloter la fleet en live au lieu de se contenter d'un snapshot figé.
- **HTTP transport** ✅ — endpoint `/mcp` monté dans le serveur HTTP principal, plus de path absolu / tsx / subprocess. Le Professeur utilise cette config par défaut.

## Architecture

Deux transports possibles. **HTTP est le défaut** (utilisé par Le Professeur,
zero subprocess, zero path absolu, marche en packaging Electron).

### Transport HTTP (par défaut)

```
┌─────────────┐    POST /mcp (SSE)    ┌─────────────────────────────────┐
│ MCP client  │ ────────────────────► │ FleetView HTTP server           │
│ (Claude     │                       │   /mcp endpoint                 │
│  Code)      │ ◄──────────────────── │   ↳ createMcpServer() inline    │
└─────────────┘    JSON-RPC reply     └─────────────────────────────────┘
```

`StreamableHTTPServerTransport` du SDK MCP, monté dans `server/index.ts`
en mode stateless (une instance fraîche par requête). Les tools tapent
directement sur les helpers internes (pas de bridge fetch — on est dans
le même process que le watcher et le PTY manager).

Config client typique :
```json
{ "mcpServers": { "claude-workspace-map": { "type": "http", "url": "http://localhost:4000/mcp" } } }
```

### Transport stdio (alternatif)

Pour les clients qui ne supportent pas HTTP (versions anciennes, certains
clients embedded), le binaire `server/mcp/main.ts` lance un MCP server stdio
qui forward via fetch vers le `/api/state` du serveur principal.

```bash
npm run mcp
```

Config client stdio :
```json
{ "mcpServers": { "claude-workspace-map": { "command": "npx", "args": ["tsx", "<abs path>/server/mcp/main.ts"] } } }
```

Inconvénient : path absolu + dépendance à tsx → c'est pour ça que HTTP est
préféré.

## Brancher dans Claude Code

### Via HTTP (recommandé)

Ajoute ceci dans `~/.claude.json` (ou via `claude mcp add` si disponible) :

```json
{
  "mcpServers": {
    "claude-workspace-map": {
      "type": "http",
      "url": "http://localhost:4000/mcp"
    }
  }
}
```

L'app FleetView doit tourner (Electron ou `npm run dev`) — sinon le client
ne pourra pas se connecter au /mcp endpoint.

### Via stdio (fallback)

Seulement si ton client MCP ne supporte pas HTTP. Cf section "Transport stdio"
ci-dessus.

---

Au prochain démarrage du client, les tools sont disponibles sous le préfixe
`mcp__claude-workspace-map__list_agents` (et autres).

## Tools disponibles

| Tool | Description | Inputs |
|---|---|---|
| `list_agents` | Snapshot compact de toutes les sessions actives | aucun |
| `get_agent_status` | Détail complet d'une session par sessionId | `sessionId` |
| `spawn_agent` | Lance une nouvelle session Claude dans un cwd (optionnellement avec un prompt initial envoyé après 1.5s) | `cwd`, `prompt?` |
| `send_message` | Écrit du texte dans une session existante (terminer par `\r` pour valider) | `sessionId`, `text` |
| `kill_agent` | Termine une session (kill du PTY) | `sessionId` |

**Note** : `send_message` et `kill_agent` échouent si la session n'est pas
liée à un PTY FleetView (sessions Claude lancées hors de l'app : "session
externe"). Le link sessionId→ptyId est établi par le watcher JSONL au moment
où Claude crée son fichier — donc post-spawn et post-premier-input.

## Wire Le Professeur

Le Professeur (l'orchestrateur Claude qui tourne dans `~/.claude-workspace-map/professor`)
utilise ce MCP server automatiquement.

À chaque `POST /api/professor/spawn`, `server/professor.ts` :
1. Lit le port FleetView actif depuis `~/.claude-workspace-map/config.json`
2. Écrit `~/.claude-workspace-map/professor/.mcp.json` avec la config du MCP
   server (chemin absolu vers `server/mcp/main.ts` + `FLEETVIEW_PORT` injecté)
3. Met à jour `CLAUDE.md` pour annoncer les 5 tools au modèle
4. Spawn la session Claude Code normalement

⚠️ **Première utilisation** : Claude Code te demandera la permission d'activer
le MCP server (one-time, anti-supply-chain). Accepte.

## Packaging Electron

Avec le transport HTTP (défaut), **plus de problème de packaging** — le MCP
server est dans le même process que le serveur HTTP, qui est lui-même
inline dans le main process Electron (`electron/main.ts` → `startServer()`).
Rien à extraire hors ASAR.

Le transport stdio (`server/mcp/main.ts`) reste limité au mode dev (tsx +
path absolu). Si on doit le packager un jour pour un client qui ne supporte
pas HTTP, il faudra pré-compiler en JS et l'extraire via `extraResources`.

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
