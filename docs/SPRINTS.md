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

## Sprint 2 — Types stricts + tests étendus + pathfinding (livré)

**Goal** : finir le hardening (validation runtime + tests + CI) ET attaquer le pain point n°1 du dogfooding user (pathfinding qui bloque).

| ID | Story | Effort | Notes |
|---|---|---|---|
| S2.1 | Zod (ou typebox) pour valider chaque ligne JSONL | 1j | **livré** — `server/schemas.ts`, `parseLine` consomme `safeParse`, sink télémétrie injectable, 4 nouveaux tests |
| S2.2 | Tests `server/watcher.ts` (add/change/unlink, byte offset, sub-agents) | 1j | **livré** — 17 specs, drives `handleAddOrChange` contre tmp dir, couvre split-line + sub-agent lifecycle complet |
| S2.3 | Strict TS settings (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`) | 0.5j | **livré** — étend la couverture tsc à `server/` + `shared/`, fixe 8 erreurs (pino default import, FSWatcher typing, handlers typés) |
| S2.4 | CI GitHub Actions (tsc + vitest sur PR) | 0.5j | **livré** — `.github/workflows/ci.yml`, Node pinné via `.nvmrc`, lint reporté en PT.6 |
| S2.5 | **A\* pathfinding grid-based** (player + NPCs) | 2j | **livré** — `NavGrid` 24px cells, 14 tests verts, intégré au PlayerController + NpcManager |

Budget : 5j dev sur 10j calendaires. Marge confortable pour le dogfooding et les pivots.

**Séquence retenue** : S2.5 (pain user, débloque mentalement) → S2.3 (filet TS) → S2.1 (Zod) → S2.2 (tests watcher) → S2.4 (CI).

### État final

| Quoi | Valeur |
|---|---|
| Stories livrées | 5/5 |
| Commits | 4 (`62c4282`, `c47cbb6`, `eb8d8e8`, `91cd642`) + CI à committer |
| Tests | 47 → **68** (+21) |
| Fichiers tests créés | `NavGrid.test.ts`, `watcher.test.ts` |
| tsc coverage étendue | `src/` → `src/` + `server/` + `shared/` |
| Nouveau code | `NavGrid.ts`, `schemas.ts`, `ci.yml`, `.nvmrc` |

### Retro

**Ce qui a bien marché**
- S2.5 en ouverture a tout de suite répondu au pain user : autopilot routé via A*, plus de scènes embarrassantes où le perso colle un mur. Le commit a été clean, 14 specs vertes du premier coup une fois le off-by-one de `markRectBlocked` réglé.
- S2.3 a été un cadeau caché : en étendant la couverture tsc à `server/`+`shared/`, on a découvert 8 bugs latents (mauvais import pino, namespace chokidar obsolète, handlers `any`). Tous fixés sans test à écrire — TS a fait le travail.
- S2.1 (Zod) a donné un bénéfice à terme : un sink télémétrie qui captera les drifts de format Claude Code AVANT qu'ils nous explosent à la figure. Le sink injectable plutôt qu'un coupling direct au logger = parser reste pur, testable.
- S2.2 (watcher tests) a couvert le pire scénario (split-line en milieu de write) sans avoir besoin de simuler chokidar — driver `handleAddOrChange` directement contre un tmp dir suffit. 17 specs en ~1h.
- Le rythme commit-après-chaque-story tient. Chaque livrable a un commit propre, message structuré, dépendances bien découpées.

**Ce qui a été dur**
- Le typage TS de la `z.union` (pas de narrowing automatique sur le discriminator dans Zod 4) m'a coûté un aller-retour. J'ai d'abord essayé `z.discriminatedUnion` puis suis retombé sur un cast manuel — pas idéal pour un schéma "exemplaire", mais fonctionnellement OK.
- Le `Omit<SessionWatcher, never> & {...}` pour exposer les méthodes privées en tests est moche mais robuste. L'alternative (rendre `handleAddOrChange` public) aurait pollué l'API. À garder en tête : si on doit tester des trucs encore plus internes, mieux vaut refactorer.
- `noImplicitReturns` n'a rien fait remonter — bon signe, le code était déjà discipliné.

**Décisions retenues**
- Zod plutôt que typebox : plus mature, communauté plus large, l'API `safeParse` est ergonomique. Pas de regret.
- Pas d'ESLint pour le moment : strict TS couvre 80 % de la valeur, on gardera lint pour quand on hire un freelance (PT.6).
- Pin Node 22 (LTS) dans `.nvmrc` pour CI, même si dev sur Node 26 localement. Plus stable et plus largement supporté côté GitHub Actions.

**Ce qu'on garde pour Sprint 3**
- Aucune story de S2 ne déborde — 5/5 livrées, marge confortable.
- PT.6 (ESLint) en backlog, à programmer dans S3 ou plus tard.
- Le sink Zod télémétrie est wiré en debug. Si on voit des drifts réels (logs ou bug user), il faudra peut-être l'élever en warn — à monitorer en dogfooding.

---

## Sprint 3 — Packaging Electron (à démarrer)

**Phase** : 1 — Foundation Pro (final sprint avant Phase 2 Talk-to-Agents)
**Goal** : sortir du `npm run dev` en parallèle. L'app devient un .dmg / .AppImage installable, hébergeant son propre Node server, qui auto-update.

| ID | Story | Effort | Notes |
|---|---|---|---|
| S3.1 | Bootstrap Electron + bundle Node server + Vite build | 2j | Le gros morceau : ipcMain pour spawn le watcher, electron-builder pour la cross-platform |
| S3.2 | Auto-update via electron-updater + GitHub releases | 1j | Bénéfice direct user : on pousse des fixes sans demander de réinstaller |
| S3.3 | Icons + branding minimal (logo, splash) | 0.5j | Première impression visuelle |
| S3.4 | Build matrice macOS arm64 / macOS x64 / Linux x64 | 1j | Notarisation macOS reportée à S7.4 (besoin d'un Apple Developer ID payant) |

Budget : 4.5j dev sur 10j calendaires. Marge pour dogfooding de la version packagée et bugs cross-platform.

**Ma proposition de séquence** : S3.1 en premier (sans ça rien d'autre n'a de sens) → S3.3 (court, motivant visuellement) → S3.4 (la matrice de build) → S3.2 (auto-update, dernier car dépend des releases GitHub qu'on doit avoir pu publier au moins une fois).

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
