# Backlog — Claude Workspace Map

Backlog produit pour la roadmap **12 mois → exit Anthropic**.

Référence : Plan complet disponible localement (non versionné).

Conventions :
- `S<phase>.<num>` = story du sprint (ex: `S1.1`)
- `P<phase>.<num>` = chantier transverse de phase
- Statut : `[ ]` pas commencé · `[~]` en cours · `[x]` livré · `[!]` bloqué

---

## Phase 1 — Foundation Pro (M1-M2)

But : PoC → outil installable, stable, partageable.

### Sprint 1 — Stabilisation (en cours)

- [x] **S1.1** Refactor `MapScene.ts` en 7 modules (~4j) — livré en 5 commits
- [ ] **S1.2** Reconnect SSE robuste + React ErrorBoundary (~1j)
- [ ] **S1.3** Logger structuré server-side + cleanup `console.*` (~0.5j)
- [ ] **S1.4** Vitest setup + tests sur `parser.ts` (~1j)
- [ ] **S1.5** ADR 0001 — décision PTY/tmux (~0.5j)

### Sprint 2 — Types stricts + tests étendus + pathfinding

- [x] **S2.1** Zod pour valider chaque ligne JSONL avant parsing — livré. Schémas dans `server/schemas.ts` (JsonlLine, ContentBlock union, Message). `parseLine` utilise `safeParse` + sink injectable pour la télémétrie (server.ts log debug). Élimine les casts `as Record<string, unknown>` du parser. 4 nouveaux tests prouvent que le sink fire sur garbage / silencieux sur JSON malformé.
- [x] **S2.2** Tests sur `server/watcher.ts` (add/change/unlink, byte offset, sub-agents) — livré. 17 specs dans `server/watcher.test.ts` couvrant : spawn/update/dedup byte-offset, split-line pending buffer, unlink, ghost files, dérivation de status, sub-agent lifecycle complet (spawn → tool → finish), Notification/SessionEnd/unknown/missing-fields, fenêtre active 30 min.
- [x] **S2.3** Strict TS settings (noUnusedLocals, noUnusedParameters, noImplicitReturns) — livré. Inclut aussi `server/` et `shared/` dans `tsconfig.include` (couvre maintenant tout le monorepo, plus juste `src/`). @types/node installé. Fallout fixé : import default `pino` (vs nommé), `import { type FSWatcher }` chokidar, typage explicite des handlers `add`/`change`/`unlink`, dead import `logger` retiré dans `server/index.ts`.
- [x] **S2.4** CI GitHub Actions : tsc + vitest sur PR + push master — livré. `.github/workflows/ci.yml`, scripts `npm run typecheck` + `npm test`, pin Node 22 via `.nvmrc`, cache npm + concurrency guard pour annuler les runs sur force-push. Lint exclu (pas d'ESLint config dans le repo) — voir PT.6.
- [ ] **PT.6** Setup ESLint + intégration au workflow CI (~0.5j). Strict TS couvre déjà la plupart des fautes courantes ; intérêt principal = consistance de style si on hire un freelance.
- [x] **S2.5** **Pathfinding A\* grid-based** pour le player (auto-walk) ET les NPCs (wander) — livré
  - `src/game/world/NavGrid.ts` : nav-grid 24px construite depuis `collisions.json` + margin 24px
  - A* 8-direction, heuristique Chebyshev, smoothing line-of-sight, anti corner-cutting
  - `PlayerController.startAutoWalk` consomme `findPath` (fallback heuristique entrance si pas de grid)
  - `NpcManager.pickWanderTarget` consomme `randomWalkableNear` (fallback random)
  - 14 tests vitest (`NavGrid.test.ts`), tous verts
  - Restant (optionnel) : overlay debug ?nav, pas urgent pour le pain point user

### Sprint 3 — Packaging Electron

- [x] **S3.1** Bootstrap Electron + bundle Node server + Vite build — livré. `electron/main.ts` + `electron/preload.ts`; `electron.vite.config.ts` (main 21 kB bundle, preload 0.25 kB, renderer 7 MB Phaser); `server/index.ts` exports `startServer(port)`, `server/start.ts` standalone entry; `npm run dev:electron` / `package:dir`; smoke tested: `/api/state` responds from embedded server.
- [x] **S3.2** Auto-update (electron-updater + GitHub releases) — livré. `setupAutoUpdater()` en prod, silent download, dialog on ready, `quitAndInstall`; `.github/workflows/release.yml` déclenché sur tag `v*`; `electron-builder.yml` avec publish GitHub provider.
- [x] **S3.3** Icons + branding minimal — livré. `build/icon.svg` pixel-art, `build/icon.icns` (macOS iconutil), `build/icon.png` (Linux); favicon 32px dans `public/`; titre "Claude Workspace Map" partout.
- [x] **S3.4** Build matrice macOS Apple Silicon / macOS Intel / Linux x64 — livré. `release.yml` matrix `--arm64 --x64` sur `macos-latest`, `--x64` sur `ubuntu-latest`; `fail-fast: false`; packaged .app testé localement (284 MB).

### Sprint 4 — Onboarding + docs

- [ ] **S4.1** Quick Start README (3 étapes max)
- [ ] **S4.2** Page Settings in-app : port, projects watchés, génération snippet hooks
- [ ] **S4.3** Vidéo demo 90s + screenshots
- [ ] **S4.4** Landing page `claude-workspace.dev` (1 page Astro)
- [ ] **S4.5** Public GitHub release + Show HN

**Métrique de fin de phase** : 500 stars, 100 installs.

---

## Phase 2 — Talk to Agents (M3-M4)

But : observateur → orchestrateur. "Wow moment" pour les démos.

### Sprint 5 — PTY launcher

- [ ] **S5.1** Intégration `node-pty` côté server
- [ ] **S5.2** `POST /api/sessions` : lance une session Claude dans un PTY (cwd, mode)
- [ ] **S5.3** Mapping `pty.pid → session_id` via JSONL nouveau fichier
- [ ] **S5.4** UI "Spawn Claude here" dans chaque house + "New session" dans sidebar avec sélecteur projet

### Sprint 6 — Talk to existing session

- [ ] **S6.1** Détection sessions tmux-aware + `tmux send-keys` fallback
- [ ] **S6.2** Chat panel React (slide-in à droite) avec historique + input
- [ ] **S6.3** Envoi via `pty.write` + streaming retour via JSONL watcher
- [ ] **S6.4** Politique de gestion sessions externes (avertir user, re-lancer dans PTY, ignorer)

### Sprint 7 — Réponses contextuelles + workspace vivant

- [ ] **S7.1** UI dédiée AskUserQuestion : parse questions, boutons radio, submit
- [ ] **S7.2** Modal ExitPlanMode : afficher plan complet, Approve / Reject / Edit
- [ ] **S7.3** Popup natif Notification (Electron) avec input réponse rapide
- [ ] **S7.4** Notarisation macOS Developer ID + Linux AppImage signing
- [ ] **S7.5** **Comportement par statut → lieu** (POIs par maison)
  - POIs : `kanban_board` (haut centre), `coding_desk` (centre), `monitor_wall` (Monitoring), `meeting_table` (Review), `coffee_corner` (hors maison)
  - Mapping : `planning`/`awaiting_approval` → board ; `coding` (Edit/Write) → desk ; `running_tool` (Bash/Read/Grep) → desk ; `idle` → coffee_corner ou wander libre ; `awaiting_input` (Notification) → board avec `?`
  - NpcManager.wander étendu pour préférer le POI lié au statut (au lieu d'un random in radius)
  - **Source** : pain point user (S1 feedback, "donner vie au workspace")
- [ ] **S7.6** **Panneau Scheduled routines** sur la map
  - Server : détecter d'où Claude Code stocke les scheduled tasks (probablement `~/.claude/scheduled-tasks.json` ou via le MCP `scheduled-tasks` bridgé). À investiguer en début de story.
  - `GET /api/routines` : liste les routines avec name / cron / nextRun / lastRun / lastStatus
  - UI : nouveau panneau pixel art dans le jardin (à côté du panneau "AI AGENT WORKSPACE"), au clic → modal avec la liste détaillée + animation "fires now" quand une routine déclenche
  - **Source** : user — "routine de Claude Code que j'aimerais retrouver"

### Sprint 8 — Polish + métriques

- [ ] **S8.1** Local insights dashboard — agréger `~/.claude/projects/*/` JSONL en KPI (sessions, tokens par modèle, top outils, top projets, plan accept rate) + 3 charts (sessions/jour, top outils, top projets). Modal plein écran ouverte par palette + raccourci `D`. Aucune télémetry, aucune collecte serveur, aucun consentement (pivot 2026-05-30 — les données existent déjà sur la machine, on les rend lisibles).
- [ ] **S8.2** Raccourcis clavier : 1/2/3 = jump entre houses, Cmd+K chat, drag-n-drop fichiers
- [ ] **S8.3** Public Beta launch (Product Hunt + Twitter + HN)

**Métrique de fin de phase** : 200 DAU, NPS ≥ 50, 5-10 témoignages filmés.

---

## Phase 3 — Team mode + premiers revenus (M5-M6)

But : démontrer une willingness to pay.

### Sprint 9 — Auth + Cloud sync

- [ ] **S9.1** Backend cloud minimal (Cloudflare Workers + D1 ou Supabase)
- [ ] **S9.2** Magic link auth (Resend ou Postmark)
- [ ] **S9.3** Toggle "Sync with team" : push état local, pull autres
- [ ] **S9.4** RGPD : on ne stocke QUE metadata (cwd, projectName, status, lastActivityAt)

### Sprint 10 — Multi-machine view

- [ ] **S10.1** Sidebar : sections par machine
- [ ] **S10.2** Avatars distincts pour agents pilotés par d'autres humains
- [ ] **S10.3** Permissions : read-only sur sessions des autres par défaut

### Sprint 11 — Pricing + paiement

- [ ] **S11.1** Stripe integration (subscriptions $12/user/mois)
- [ ] **S11.2** Page pricing landing
- [ ] **S11.3** Trial 14j + paywall sync cloud

### Sprint 12 — Marketing push

- [ ] **S12.1** Outreach LinkedIn/Twitter aux 200 DAU actifs (interviews, témoignages)
- [ ] **S12.2** Articles invités (Console.dev, Bytes.dev, dev.to)
- [ ] **S12.3** Conférences locales si timing OK
- [ ] **S12.4** **Premiers contacts DevRel Anthropic** — pitch produit, feedback, pas encore "à vendre"

**Métrique de fin de phase** : 5 équipes payantes (50 user accounts), 500 DAU.

---

## Phase 4 — Pré-deal (M7-M9)

### Sprint 13-14 — Notifications + intégrations

- [ ] **S13.1** Notifs natives macOS/Linux pour `awaiting_approval` + `blocked`, action inline
- [ ] **S13.2** Slack integration (status pings équipe)
- [ ] **S13.3** Discord integration
- [ ] **S14.1** GitHub integration (lier sessions aux PRs)

### Sprint 15-16 — Performance + scale

- [ ] **S15.1** Optim chokidar pour 500+ JSONL files (eviction + index)
- [ ] **S15.2** Backend cloud : indexes proper, p99 < 100ms
- [ ] **S16.1** Stress test : 50 sessions simultanées sur 1 machine

### Sprint 17-18 — Présentation publique

- [ ] **S17.1** Public launch V1 (Product Hunt top 5 visé)
- [ ] **S17.2** Coverage presse (The New Stack, InfoQ, Anthropic blog)
- [ ] **S18.1** **Premier contact concret Anthropic** — conversation business, LOI/term sheet préliminaire

**Métrique de fin de phase** : 2000 DAU, 30 équipes payantes (~$20k MRR), 1 conversation acquisition en cours.

---

## Phase 5 — Closing (M10-M12)

### Sprint 19-20 — Due diligence ready

- [ ] **S19.1** Audit dépendances (Snyk) + licences (FOSSA)
- [ ] **S19.2** Documentation technique exhaustive (ADRs, runbooks, schémas)
- [ ] **S20.1** Audit légal : statuts entreprise, IP transferable, CGU, RGPD

### Sprint 21-22 — Négociation deal

- [ ] **S21.1** Avocat M&A
- [ ] **S21.2** Pitch deck acquisition (différent du sales deck)
- [ ] **S22.1** Term sheet négociée (earn-out vs cash up-front)
- [ ] **S22.2** Approches secondaires si Anthropic traîne (Cursor, MS DevDiv, GitHub)

### Sprint 23-24 — Closing ou pivot

- [ ] **S23.1** Signing si deal OK
- [ ] **S23.2** Plan transition tech + équipe
- [ ] **S24.1** Si pas de deal : pivot SaaS, reprendre 12-18 mois avec metrics solides

---

## Chantiers transverses (toutes phases)

- [x] **PT.1** Mutualiser `STATUS_COLOR`/`STATUS_LABEL` dans `shared/agent-ui.ts` — fait dans S1.1.A (commit 56faa62)
- [ ] **PT.2** Bus factor : code propre + ADRs + docs continus
- [ ] **PT.3** Dogfooding : utiliser le widget chaque jour, noter friction
- [ ] **PT.4** User interviews : 2 calls/sem à partir Phase 2
- [x] **PT.5** Split `NpcManager` (685 → 444 lignes) : `CharacterSpriteFactory` extrait (280 lignes), NpcManager garde lifecycle + wander + overlays. Livré 2026-05-30 (`e578fa9`). 68/68 tests verts.

---

## Idées non priorisées

À garder pour plus tard ou parking lot :
- Day/night cycle visuel basé sur l'heure réelle
- Statistiques par session (temps moyen, nombre de tools, coût estimé)
- History timeline dans la bulle de dialogue (dernières N actions)
- Vue mini-map (zoom out vue d'ensemble)
- Filtrage sidebar par statut/projet/role
- Click sur projet header pour collapse/expand
- Sound effects (notification, blocked, etc.)
- Animation spawn maison quand 1er agent arrive

## Décisions PO récentes (feedback user → bucket)

Triage du 2026-05-24 sur 4 idées remontées par dogfooding :

| Idée | Décision |
|---|---|
| Fenêtre de contexte pour parler / approuver une action | Déjà au plan — Phase 2, Sprint 5-7 (PTY wrap + Réponses contextuelles). Pas de changement. |
| Améliorer le pathfinding (blocage dans les murs) | Story S2.5 ajoutée. A* grid-based, ~2j, démarre Sprint 2. |
| Comportement par statut → lieu (planning → tableau, coding → bureau) | Story S7.5 ajoutée. Liée à l'interactivité, démarre Sprint 7. |
| Tâches planifiées (routines Claude Code) sur la map | Story S7.6 ajoutée. Panneau dans le jardin + modal. À investiguer le stockage des routines en début de story. |
