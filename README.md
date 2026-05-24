# Claude Workspace Map

**A living RPG map of your Claude Code sessions.**

Watch your AI agents move through pixel-art offices in real time — coding, planning, waiting for input, spawning sub-agents. Instead of switching between terminals to check what each Claude is doing, glance at the map.

> Built for developers who run multiple Claude Code sessions in parallel and want a single, delightful view of what's happening.

---

## What it looks like

<!-- TODO: add demo GIF here -->
<!-- Suggested: 30s screen recording showing agents moving, status changes, dialogue bubbles -->

![Claude Workspace Map screenshot](docs/screenshot.png)

---

## Features

- **Live agent tracking** — reads `~/.claude/projects/**/*.jsonl` with zero config; every session appears as a character on the map within seconds
- **Status-aware sprites** — each agent's appearance reflects what it's doing: `coding` (at the desk), `planning` (at the board), `awaiting_input` (question mark bubble), `idle` (wandering)
- **Dialogue bubbles** — shows the current tool and file path (`Edit → src/App.tsx`, `Bash → npm test`, …)
- **Sub-agent lifecycle** — spawned agents appear, work, and fade when done
- **A\* pathfinding** — agents navigate around obstacles on a real collision grid; no more clipping through walls
- **Sidebar HUD** — full list of active sessions with status, project name, last tool, elapsed time
- **Instant hooks** — optional Claude Code hooks fire a `POST /api/hook` for immediate `awaiting_approval` / `SessionEnd` updates (no polling lag)
- **Electron app** — ships as a `.dmg` / `.AppImage`; double-click to launch, no `npm run dev` required
- **Auto-update** — the app checks for new releases on GitHub and prompts to install in one click

---

## Quick start

### Option A — Desktop app (recommended)

Download the latest release for your platform from the [Releases](../../releases) page:

| Platform | File |
|---|---|
| macOS Apple Silicon | `Claude-Workspace-Map-arm64.dmg` |
| macOS Intel | `Claude-Workspace-Map-x64.dmg` |
| Linux | `Claude-Workspace-Map-x86_64.AppImage` |

Open the app. It starts the server automatically on `localhost:4000` and watches `~/.claude/projects/` immediately.

### Option B — From source

```bash
git clone https://github.com/guillaumeArgiles/claude-workspace-map.git
cd claude-workspace-map
npm install

# Web mode (opens in your browser)
npm run dev

# Electron mode (opens as a desktop window)
npm run dev:electron
```

Requires **Node 22+**.

---

## Optional: instant status updates via hooks

By default the app tails JSONL files. For two extra signals — *awaiting human input* and *session ended* — add these hooks to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -sf -X POST -H 'Content-Type: application/json' -d @- http://localhost:4000/api/hook >/dev/null 2>&1 || true"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -sf -X POST -H 'Content-Type: application/json' -d @- http://localhost:4000/api/hook >/dev/null 2>&1 || true"
          }
        ]
      }
    ]
  }
}
```

Restart open Claude Code sessions to pick up the new settings. The `|| true` guard ensures the hook never blocks a Claude turn when the map is offline.

See [`docs/HOOKS_SETUP.md`](docs/HOOKS_SETUP.md) for more detail.

---

## How it works

```
~/.claude/projects/**/*.jsonl
        │  (chokidar watcher)
        ▼
  Node HTTP server  ──── POST /api/hook  ◄── Claude Code hooks
        │                                    (Notification, SessionEnd)
        │  SSE  /api/events
        ▼
  React + Phaser 3 renderer
        │
        ├── AgentSyncer   maps session state → NPC instances
        ├── NpcManager    sprite lifecycle, wander, status overlays
        ├── PlayerController  A* autopilot to clicked NPC
        ├── DialogueUI    tool-use bubbles
        └── CollisionLayer  physics bodies from collisions.json
```

Each `.jsonl` file is one Claude Code session. The watcher reads new bytes as they appear, parses each line with Zod, derives agent status from tool-use patterns, and broadcasts `agent_spawned / agent_updated / agent_removed` events over SSE.

---

## Tech stack

| Layer | Tech |
|---|---|
| Renderer | [Phaser 3](https://phaser.io) + React 18 + TypeScript |
| Build | Vite 5 + electron-vite |
| Desktop | Electron 42 + electron-builder |
| Server | Node.js `http` (no framework) |
| Watching | chokidar 5 |
| Validation | Zod 4 |
| Logging | pino + pino-pretty |
| Tests | Vitest (68 specs) |
| CI | GitHub Actions (typecheck + tests on every PR) |

---

## Roadmap

The project follows a 12-sprint roadmap toward a full multi-session orchestration layer.

**Phase 1 — Foundation (done)**
- [x] Modular Phaser scene (NpcManager, AgentSyncer, PlayerController, …)
- [x] Robust SSE reconnect + React error boundary
- [x] Structured logging (pino), strict TypeScript, Zod validation
- [x] 68 automated tests, CI on GitHub Actions
- [x] A\* pathfinding grid (24 px cells, 8-direction, line-of-sight smoothing)
- [x] Electron packaging — `.dmg` (arm64 + x64) + `.AppImage`
- [x] Auto-update via GitHub Releases

**Phase 2 — Talk to agents** *(coming)*
- [ ] PTY launcher — spawn and control Claude sessions from the map
- [ ] Chat panel — send messages to any running agent
- [ ] Contextual responses — approve plans, answer `AskUserQuestion` prompts
- [ ] Proactive master agent — when all sessions are idle, suggests tasks, asks about your project, preps your day

**Phase 3 — Team mode** *(planned)*
- [ ] Cloud sync — see teammates' agents on the same map
- [ ] Multi-machine view
- [ ] Pricing (free local, Pro team sync)

---

## Development

```bash
npm run dev            # Vite dev server + Node server (browser)
npm run dev:electron   # Vite + Node server + Electron window
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run build          # electron-vite build (prod bundles)
npm run package:dir    # build + package to release/ (unpacked, no signing)
```

See [`docs/SPRINTS.md`](docs/SPRINTS.md) for the sprint history and [`docs/BACKLOG.md`](docs/BACKLOG.md) for the full product backlog.

---

## Credits

Character sprites: **[Pipoya — Free RPG Character Sprites 32×32](https://pipoya.itch.io/pipoya-free-rpg-character-sprites-32x32)**, obtained via [clkao/swonline](https://github.com/clkao/swonline).

See [CREDITS.md](CREDITS.md) for the full attribution list.

---

## License

MIT — see [LICENSE](LICENSE).
