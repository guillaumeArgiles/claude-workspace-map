# Claude Workspace Map — MCP server

Expose les capacités de FleetView (lister/contrôler les agents Claude actifs) à
n'importe quel client MCP via le standard [Model Context Protocol](https://modelcontextprotocol.io).

## Statut

- **Spike** ✅ — `list_agents` opérationnel
- **Impl complète** ✅ — 5 tools : list, get_status, spawn, send_message, kill (13 specs vitest sur le bridge)
- **Wire Professeur** ✅ — `server/professor.ts` écrit un `.mcp.json` dans le dossier du Professeur au moment du spawn, avec le port FleetView courant injecté. Le Professeur peut maintenant lire ET piloter la fleet en live au lieu de se contenter d'un snapshot figé.

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

## Packaging Electron — limites connues

Le MCP server tourne via `npx tsx server/mcp/main.ts`. Dans une app Electron
packagée, tsx n'est pas disponible et le fichier .ts est dans l'ASAR (non
exécutable depuis l'extérieur). À résoudre quand on packagera : pré-compiler
`server/mcp/main.ts` en JS et l'extraire hors ASAR via `extraResources`.

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
