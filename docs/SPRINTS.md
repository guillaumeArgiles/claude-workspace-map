# Sprints — Historique et sprint en cours

## Conventions

- **Cadence** : 2 semaines (10 jours ouvrés)
- **Definition of Done** par story : `tsc --noEmit` OK, dogfooding 1× minimum, commit propre, ligne ajoutée ou cochée dans [BACKLOG](BACKLOG.md)
- **Definition of Done par sprint** : retro écrite ici, métrique de fin atteinte (sinon on documente l'écart)

---

## Sprint 1 — Stabilisation (livré)

**Phase** : 1 — Foundation Pro
**Goal** : Le PoC devient un outil sur lequel on peut écrire des tests, refactorer 2 mois plus tard, et qu'on n'a pas honte de montrer.
**Budget** : 7j dev sur 10j calendaires
**Démarré** : aujourd'hui

### Stories

| ID | Story | Effort | Statut |
|---|---|---|---|
| S1.1 | Refactor `MapScene.ts` en 7 modules | 4j | **livré** (5 commits, MapScene 1690 → 151 lignes) |
| S1.2 | Reconnect SSE robuste + ErrorBoundary | 1j | **livré** (`0568fa2`) |
| S1.3 | Logger structuré server-side (pino) | 0.5j | **livré** (`4dfe321`) |
| S1.4 | Vitest setup + tests `parser.ts` | 1j | **livré** (`951f833`, 33 tests, 96.6 % coverage) |
| S1.5 | ADR 0001 — décision PTY wrap | 0.5j | **livré** (`6299dc0`) |
| —    | Triage feedback user (4 idées) | bonus | **livré** (`1e0a5e0`) — S2.5, S7.5, S7.6 ajoutées au backlog |

### Décisions prises

- **Cible architecture** : 7 modules pour MapScene (NpcManager, AgentSyncer, PlayerController, DialogueUI, HouseLayout, CollisionLayer + orchestrator MapScene). Voir le détail dans le kickoff Sprint 1.
- **Pas de framework de test côté frontend** ce sprint. On verra au Sprint 2 si on en a besoin.
- **Logger pino** retenu sur consola pour la perf JSON natif.

### S1.1 livrée — récap

5 commits successifs, `tsc --noEmit` vert à chaque pas, vérification visuelle à mi-parcours (après commit C) :

| Commit | Sujet | Résultat |
|---|---|---|
| `56faa62` | A — Mutualiser status colours/labels dans shared/agent-ui | MapScene + sidebar agrees |
| `(B)` | Extract HouseLayout + gameplay constants + agents/types | Types/constants hors classe |
| `457e1b6` | C — NpcManager (sprites, lifecycle, overlays, wander) | MapScene 1690 → 948 |
| `(D)` | DialogueUI + PlayerController | 948 → 651 |
| `34a3dad` | E1 — AgentSyncer | 651 → 358 |
| `41dbb32` | E2 — CollisionLayer, MapScene pur orchestrator | 358 → **151** |

Distribution finale des 9 fichiers issus de S1.1 :

```
MapScene.ts            151
AgentSyncer.ts         331
NpcManager.ts          619   ← seul dépasse la cible de 400, voir PT.5
CollisionLayer.ts      246
PlayerController.ts    253
DialogueUI.ts          132
houseLayout.ts         111
gameplayConstants.ts    42
agents/types.ts         44
```

NpcManager reste épais à cause du sprite loader (buildCharacterAnimations + ensureCleanedTexture + drawPlaceholderFrame ≈ 250 lignes). Ajouté en dette dans le backlog (PT.5).

### Retro

**Ce qui a bien marché**
- Cadence S1.1 en 5 sous-commits → chaque palier vérifiable avec `tsc --noEmit`, possibilité de revert sans casse.
- Le user a vérifié visuellement après commit C (NpcManager) avant qu'on enchaîne D/E/E2 — bonne discipline qui a évité de transporter une régression.
- L'extraction des managers (NpcManager / AgentSyncer / DialogueUI / PlayerController / CollisionLayer) a clarifié les frontières au point où S2 pourra hire un freelance pour des features isolées.
- Le triage user feedback en milieu de sprint a transformé des intuitions ("je bloque dans les murs") en stories backlog priorisées (S2.5 pathfinding A*).
- Pino + pino-pretty couvre dev + prod sans ajouter de complexité (~10 lignes).

**Ce qui a été dur**
- Le refactor MapScene a demandé 7 commits successifs (≈2j calendaires) — plus long que les 4j budgetés en story S1.1 nominalement, mais sous-estimé surtout sur la phase NpcManager (les méthodes se référençaient en chaîne).
- Sur S1.4, un commit accidentel de `coverage/` (15 fichiers HTML) → corrigé par un commit `24d2cdf` qui retire + ajoute `coverage` à `.gitignore`. Petite leçon : penser au gitignore avant de livrer un changement qui génère des artefacts.
- Le test `Read/Edit/Write → home-shortened path` est tombé au premier run parce que mon attendu était wishful-thinking. Reécrit en lisant la vraie logique.

**Décisions retenues**
- 7 modules pour la scène, 1 manager par responsabilité — confirmé valider.
- pino par-dessus winston/consola — choix de la perf JSON native, regretté nulle part.
- Vitest plutôt que Jest pour rester aligné avec Vite. Setup en <5 min, tests en <500 ms.
- ADR 0001 retient le PTY wrap (D) avec tmux send-keys (C) en fallback pour les power-users multiplexer. Locké avant Sprint 5.

**Ce qu'on garde pour Sprint 2**
- Aucune story de S1 ne déborde — sprint clean.
- Les artefacts persistants (BACKLOG, SPRINTS, adr/) fonctionnent bien. À continuer.

---

## Sprint 2 — Types stricts + tests étendus + pathfinding (à démarrer)

**Goal** : finir le hardening (validation runtime + tests + CI) ET attaquer le pain point n°1 du dogfooding user (pathfinding qui bloque).

| ID | Story | Effort | Notes |
|---|---|---|---|
| S2.1 | Zod (ou typebox) pour valider chaque ligne JSONL | 1j | Pose la base de la sécurité runtime |
| S2.2 | Tests `server/watcher.ts` (add/change/unlink, byte offset, sub-agents) | 1j | Le watcher est le 2e composant le plus à risque après parser.ts |
| S2.3 | Strict TS settings (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`) | 0.5j | **livré** — étend la couverture tsc à `server/` + `shared/`, fixe 8 erreurs (pino default import, FSWatcher typing, handlers typés) |
| S2.4 | CI GitHub Actions (tsc + vitest + lint sur PR) | 0.5j | Le repo n'est pas encore public, mais on le prépare |
| S2.5 | **A\* pathfinding grid-based** (player + NPCs) | 2j | **livré** — `NavGrid` 24px cells, 14 tests verts, intégré au PlayerController + NpcManager |

Budget : 5j dev sur 10j calendaires. Marge confortable pour le dogfooding et les pivots.

**Mes propositions de séquence** : S2.5 en premier (le pain user, débloque mentalement), puis S2.3 (filet TS), puis S2.1/S2.2 (Zod + tests watcher en duo), enfin S2.4 (CI).

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
