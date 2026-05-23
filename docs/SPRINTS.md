# Sprints — Historique et sprint en cours

## Conventions

- **Cadence** : 2 semaines (10 jours ouvrés)
- **Definition of Done** par story : `tsc --noEmit` OK, dogfooding 1× minimum, commit propre, ligne ajoutée ou cochée dans [BACKLOG](BACKLOG.md)
- **Definition of Done par sprint** : retro écrite ici, métrique de fin atteinte (sinon on documente l'écart)

---

## Sprint 1 — Stabilisation (en cours)

**Phase** : 1 — Foundation Pro
**Goal** : Le PoC devient un outil sur lequel on peut écrire des tests, refactorer 2 mois plus tard, et qu'on n'a pas honte de montrer.
**Budget** : 7j dev sur 10j calendaires
**Démarré** : aujourd'hui

### Stories

| ID | Story | Effort | Statut |
|---|---|---|---|
| S1.1 | Refactor `MapScene.ts` en 7 modules | 4j | en cours |
| S1.2 | Reconnect SSE robuste + ErrorBoundary | 1j | à faire |
| S1.3 | Logger structuré server-side | 0.5j | à faire |
| S1.4 | Vitest setup + tests `parser.ts` | 1j | à faire |
| S1.5 | ADR 0001 — décision PTY/tmux | 0.5j | à faire |

### Décisions prises

- **Cible architecture** : 7 modules pour MapScene (NpcManager, AgentSyncer, PlayerController, DialogueUI, HouseLayout, CollisionLayer + orchestrator MapScene). Voir le détail dans le kickoff Sprint 1.
- **Pas de framework de test côté frontend** ce sprint. On verra au Sprint 2 si on en a besoin.
- **Logger pino** retenu sur consola pour la perf JSON natif.

### Retro (à compléter en fin de sprint)

_À remplir._

---

## Historique des sprints (avant qu'on tienne ce fichier)

Sprints implicites livrés avant ce backlog, gardés pour mémoire :

| Sprint | Livrable | Commit |
|---|---|---|
| S0.1 | Phaser + React scaffold | `37eb473` |
| S0.2 | Map background + collisions + player + 8 NPCs + drawing tool | `37eb473` |
| S0.3 | Hitbox tuning + role label + camera follow zoom 1.2 | `f3cd103` |
| S0.4 | JSONL watcher + SSE + dynamic agents + sidebar HUD + autopilot | `bdb525f` |
| S0.5 | Status behaviors + sub-agent lifecycle + Claude hooks | `cc92596` |

Ces sprints n'étaient pas formalisés. On démarre la cadence officielle au Sprint 1.
