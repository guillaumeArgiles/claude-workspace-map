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

## Sprint 3 — Packaging Electron (livré)

**Phase** : 1 — Foundation Pro (final sprint avant Phase 2 Talk-to-Agents)
**Goal** : sortir du `npm run dev` en parallèle. L'app devient un .dmg / .AppImage installable, hébergeant son propre Node server, qui auto-update.

| ID | Story | Effort | Statut |
|---|---|---|---|
| S3.1 | Bootstrap Electron + bundle Node server + Vite build | 2j | **livré** (`3d482b0`) |
| S3.2 | Auto-update via electron-updater + GitHub releases | 1j | **livré** (`f87abb2`) |
| S3.3 | Icons + branding minimal (logo, splash) | 0.5j | **livré** (`c1b97cd`) |
| S3.4 | Build matrice macOS arm64 / macOS x64 / Linux x64 | 1j | **livré** (`797ecf3`) |

Budget : 4.5j dev sur 10j calendaires.

### Architecture retenue

- `electron/main.ts` importe directement `startServer()` depuis `server/index.ts` — même process, pas de child_process. Avantage : logs unifiés, shutdown propre, pas de IPC overhead. Migration possible vers `UtilityProcess` (Electron v29+) si besoin en Phase 3.
- `externalizeDepsPlugin()` externalise tous les node_modules (chokidar, pino, zod…) — ils voyagent avec le package mais ne sont pas bundlés dans le 21 kB main bundle.
- Renderer bundlé séparément par Vite → `dist/assets/index-*.js` (7 MB, Phaser inclus). En prod : `loadFile(dist/index.html)`. En dev : `loadURL(VITE_DEV_SERVER_URL)`.
- `npm run dev:electron` = electron-vite dev (Vite dev server + Electron + serveur embedded). `npm run dev` = mode navigateur pur (backward compat).

### Décisions prises

- **Serveur embedded vs spawned** : inline dans le main process (Option A). Simpler, logs unifiés. Pas besoin d'IPC.
- **Electron vs macOS animated wallpaper** : Electron retenu (cross-platform, Phase 2 chat panel, Phase 3 team mode). Le "widget mode" (fenêtre borderless always-below) reste possible en bonus S3.1+ avec 3 lignes.
- **Notarisation** : reportée à S7.4 (Apple Developer ID payant). `identity: null` pour l'instant, distribué hors App Store.
- **Signing** : `arm64 requires signing` warning ignoré pour dev — ne bloque pas le lancement local.

### État final

| Quoi | Valeur |
|---|---|
| Stories livrées | 4/4 |
| Commits | 4 (`3d482b0`, `f87abb2`, `c1b97cd`, `797ecf3`) |
| Tests | 68/68 (inchangé) |
| App packagée | macOS arm64 — 284 MB (17 MB ASAR) |
| Workflow release | trigger `v*` → macos dmg arm64+x64 + Linux AppImage x64 |
| tsc | ✅ clean |

### Retro

**Ce qui a bien marché**
- L'architecture "server inline dans main process" est propre : pas d'IPC, shutdown en cascade `before-quit → stopServer() → app.quit()`, logs pino visibles dans la console Electron en dev.
- electron-vite 5 gère les 3 bundles (main/preload/renderer) avec une config lisible. Custom paths (`electron/main.ts` au lieu de `src/main/`) fonctionnent sans friction.
- `externalizeDepsPlugin` + electron-builder `dependencies` = les 4 deps serveur (chokidar, pino, pino-pretty, zod, electron-updater) sont embarquées proprement sans bundling complexe.
- Le smoke test "lancer l'app packagée, curl /api/state, vérifier les agents" a été vert du premier coup.
- Déplacement de phaser/react/tsx/concurrently vers devDeps : packaged app n'embarque que ce qui est nécessaire à runtime.

**Ce qui a été dur**
- `electron-updater` doit être en `dependencies` (pas devDeps) pour être packagé. npm l'avait mis en devDeps par défaut — corrigé manuellement.
- `build/icon.icns` nécessite `iconutil` macOS (present par défaut) + un `.iconset/` proprement structuré avec les noms exacts Apple. PIL pour générer les PNG, iconutil pour l'icns.
- Le warning `arm64 requires signing` est bloquant pour distribution (App Store / Gatekeeper), pas pour dev local. Documenté, action en S7.4.

**Ce qu'on garde pour Sprint 4**
- Aucune story de S3 ne déborde — 4/4 livrées.
- À faire avant la première release publique : renseigner `owner` + `repo` dans `electron-builder.yml`, puis `git tag v0.1.0 && git push --tags`.
- PT.5 (split NpcManager) toujours en attente — à attaquer en Sprint 4 ou en dehors des stories.

---

## Sprint 5 — PTY launcher (livré)

**Phase** : 2 — Talk to Agents
**Goal** : sortir du mode observateur. Lancer + reprendre + contrôler une session Claude Code depuis la map.

| ID | Story | Statut |
|---|---|---|
| S5.1 | Intégration `node-pty` côté server | **livré** (`ec728eb`) |
| S5.2 | `POST /api/sessions` — lance Claude en PTY | **livré** (`ec728eb`) |
| S5.3 | UI "Spawn Claude" (palette + sidebar) | **livré** (`ec728eb`) |
| S5.4 | Terminal overlay xterm.js + minimize-to-badge | **livré** (`bab1ae6`, `3893bdb`) |
| —    | Crash recovery v2.1.x (originalFile null) | **livré bonus** (`aedb0c6`, `98b6845`) |
| —    | Resume via `claude --continue` | **livré bonus** (`1ea31b4`, `d02ffd6`) |

### État final

- Toutes les stories S5.1–S5.4 livrées
- xterm.js retenu après tentative pre+input — isolation clavier propre via `attachCustomKeyEventHandler` (`43e156e`)
- Bug Claude Code v2.1.x découvert en dogfooding → bannière de recovery automatique avec respawn fresh

---

## Sprint 6 — Talk to existing session (pivot)

**Phase** : 2 — Talk to Agents
**Goal** initial : chat panel slide-in pour envoyer du texte aux agents.

| ID | Story | Statut |
|---|---|---|
| S6.1 | Chat panel inline dans la sidebar | **livré puis retiré** (`866dd09` → `e1f254e`) |
| S6.2 | Display PTY output dans le chat | **livré puis retiré** (`4b27b35`) |
| S6.3 | Thinking indicator | **livré puis retiré** (`51c0266`) |

### Pivot

Après dogfooding, le chat panel inline doublonne le terminal overlay (déjà branché sur le même PTY). Décision : supprimer le chat panel, le terminal overlay reste le canal unique pour parler à un agent. Économie de code + cohérence d'UX.

S6.4 (politique sessions externes / tmux) reporté — non bloquant tant que les users restent dans le PTY interne.

---

## Sprint 7 — Réponses contextuelles + RPG dialogue (livré + bonus)

**Phase** : 2 — Talk to Agents
**Goal** : que l'utilisateur réponde à `ExitPlanMode` et `AskUserQuestion` sans quitter la map. Et que la map devienne vraiment vivante.

| ID | Story | Statut |
|---|---|---|
| S7.1 | UI dédiée AskUserQuestion (radio + submit) | **livré** (`8a767d6`) |
| S7.2 | Modal ExitPlanMode (plan + Approve/Reject) | **livré via inline widget** (`8a767d6`) |
| S7.3 | Notifications natives `awaiting_approval` / `blocked` | **livré** (`5e96f77`) |
| S7.4 | Notarisation macOS Developer ID | **reporté** (Apple Developer ID payant) |
| S7.5 | Comportement par statut → POIs par maison | **reporté** |
| S7.6 | Panneau Scheduled routines dans le jardin | **reporté** |
| B3   | RPG agent interactions (E key, dialogue NPC) | **livré bonus** (`1743f53`) |
| B4   | Le Professeur — orchestrateur IA streaming | **livré bonus** (`e6eb2e0`, refactor PTY `cc16970`) |
| —    | Dismiss agents (✕ par ligne + 🧹 bulk) | **livré bonus** (`7ab5f58`) |
| —    | Keyboard shortcuts pour tout (N/P/E/1-3/B/Esc) | **livré bonus** (`db65f7d`) |
| —    | NPC status animations + RPG design polish (S8b) | **livré bonus** (`e99f16d`) |

### Décisions

- **Approval widget inline plutôt que modal** : ExitPlanMode + AskUserQuestion partagent le même widget dans la sidebar — plus discret, pas d'interruption focus. La modal RPG (`RPGApprovalUI`) répond au même besoin côté map (E sur un NPC en attente).
- **Professeur via PTY plutôt que Anthropic SDK** : cohérence avec les autres agents, pas de clef API à gérer, l'orchestrateur peut utiliser tous les tools de Claude Code.
- **S7.4/S7.5/S7.6** restent au backlog. La notarisation deviendra bloquante avant la beta publique ; les POIs et routines sont du polish "workspace vivant" qui peut attendre les premiers retours users.

---

## Sprint 8 — Polish + métriques + i18n (livré, pivots)

**Phase** : 2 — Talk to Agents (final)
**Goal initial** : KPIs + télémetry, raccourcis clavier, beta publique.

| ID | Story | Statut |
|---|---|---|
| S8.1 | Local insights dashboard (KPIs + 3 charts, `D` shortcut) | **livré** (`3b60945`) |
| S8.2 | Palette `⌘K` + drag-n-drop NPCs entre houses | **livré** (`c305171`) |
| S8.3 | Public Beta launch (Show HN + Product Hunt) | **non démarré** |
| —    | Agent context menu (`Space` → terminal/plan/btw/fast/kill) | **livré bonus** (`9d4d34e`) |
| —    | Persistent settings panel (theme, sidebar width, port) — S4.2 rattrapé | **livré bonus** (`aab90c5`) |
| —    | Landing page marketing — S4.4 rattrapé | **livré bonus** (`da5f023`) |
| —    | i18n EN / FR / ES (Zod `locale` + hand-rolled module) | **livré bonus** (`a80ebe1`) |
| —    | Docs à jour (README + landing) reflet des features semaine | **livré** (`a6cf858`) |

### Pivots

- **S8.1 reframed (pivot 2026-05-30)** : abandon de la collection d'events télémetry + consent banner. À la place, lecture des JSONL existants qui sont déjà sur la machine → dashboard local, zero télémetry. Moins ambitieux mais ship-able le jour même, et plus aligné avec la valeur "privacy-first" du produit.
- **i18n unscoped** : pas dans le sprint planning initial. Ajouté en cours de route parce que le moment est bon (la surface UI vient de doubler avec palette + stats + settings) avant que la dette cristallise. Hand-rolled (~155 lignes, zero dep) plutôt que react-i18next vu la taille de la surface.

### État final

- 2/3 stories planifiées livrées, S8.3 reportée
- 4 bonus livrés (context menu, settings, landing, i18n)
- 68/68 tests verts, `tsc --noEmit` clean après chaque commit
- Phase 2 (Talk to Agents) est techniquement complète — il reste S8.3 (launch) et les nice-to-have S7.4/S7.5/S7.6

### Ce qu'on garde pour la suite

- **Avant prochain feature work** : décider entre (1) ship & valider (S8.3 + S7.4 notarisation + tag v0.2.0), (2) finir Phase 2 (S7.5 POIs, S7.6 routines, chat panel free-text), ou (3) attaquer Phase 3 (cloud sync).
- **Dette résolue depuis** : `NpcManager.ts` splitté (PT.5 livré `e578fa9`, 685 → 444 lignes, `CharacterSpriteFactory` extrait à 280 lignes — `ee2602e` coche dans BACKLOG, 68/68 tests verts).
- **Reste à capturer** : screenshots stats dashboard à capturer manuellement.

---

## État après Sprint 8 — 2026-05-30

**Phase 1** quasi close : il reste S4.3 (vidéo demo 90s), S4.5 (release publique), S7.4 (notarisation), PT.6 (ESLint). Aucun n'est bloquant pour dogfooding interne.

**Phase 2** techniquement complète : PTY, terminal overlay, approval widgets, notifs, Professeur, RPG dialogues. Reste S7.5 (POIs par statut), S7.6 (routines panel), S6.4 (sessions externes) — du polish "workspace vivant", pas du chemin critique.

**Tag local** : `v0.1.0` créé mais **pas** publié comme GitHub Release.

### Décision d'orientation — 2026-05-30

Après bilan PM, deux pistes étaient sur la table :
1. **Mode launch** — pousser la release publique, récupérer du feedback réel.
2. **Mode terrain de jeu solo** — continuer à construire pour le plaisir + skill-building, sans pression user.

**Choix retenu : option 2.** Le projet reste à usage interne, le backlog est réorganisé par thèmes techniques (game dev, AI orchestration, workspace intel, perf, extensibility, multiplayer) — voir [BACKLOG.md](BACKLOG.md) refondu.

Toute la stratégie produit / launch / kill list est parquée dans [STRATEGY.md](STRATEGY.md), prête à ressortir le jour où on switch en mode "ship" (critères de switch documentés dans le même fichier).

### Ce que ça change concrètement

- Plus de "Sprint N" planifiés à l'avance. On picks une story dans un thème, on la fait, on en picks une autre.
- Tests verts + tsc clean restent les seuls engagements de qualité.
- Les Phases 3-5 originales (auth, cloud, pricing, M&A) ne sont plus dans le backlog opérationnel — elles vivent dans STRATEGY.md comme parking lot.
- Les stories S7.5 et S7.6 sont remises dans le pool, renommées TA.4 (POIs) et TC.3 (routines).

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
