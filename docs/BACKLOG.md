# Backlog technique — Claude Workspace Map

## Manifeste

Ce backlog est un **terrain de jeu solo**. Pas de deadline, pas d'users (encore). Tu picks un thème qui te fait envie, tu shippes quand ça te plaît, tu apprends.

**Objectif réel** : monter en compétence en construisant un truc qu'on a vraiment envie d'utiliser.

La stratégie produit/launch (décisions de ce qu'on supprime, à quel moment on lance, gates de décision) vit dans [STRATEGY.md](STRATEGY.md). À ressortir le jour où on switch en mode "ship".

Conventions :
- `T<thème>.<num>` = story d'un thème (ex: `TA.1` = Game dev, story 1)
- Statut : `[ ]` pas commencé · `[~]` en cours · `[x]` livré · `[!]` bloqué · `[?]` à arbitrer

---

## Ordre d'attaque actuel (décidé 2026-05-30)

Roadmap de travail séquentielle, ~4-5 semaines calendaires en mode side project.

### Étape 1 — MCP server (TB.7) — ✅ **LIVRÉ**

Infrastructure d'abord. Chaque feature qui manipule des agents passe maintenant par cette couche.

- ✅ Spike (`b8f4856`) — stdio server + `list_agents` hardcodé
- ✅ Impl complète (`f07e2d5`) — 5 tools (list, get_status, spawn, send_message, kill) + 13 specs vitest
- ✅ Wire Professeur (`7e052ee`) — `.mcp.json` auto-écrit + CLAUDE.md actualisé
- ✅ HTTP transport (`b4f70ae`) — endpoint `/mcp` mounted dans le serveur principal, kill du path hardcodé, marche en packaging Electron

### Étape 2 — Particles (TA.2) — ✅ **LIVRÉ**

3 effets, ParticleFx manager + texture procédurale, hookés sur status change via NpcManager.refreshStatusBadge.

- ✅ TA.2.1 Sparkles violets sur `coding` (`c609fe0`)
- ✅ TA.2.2 Smoke gris sur `blocked` (`a387b87`)
- ✅ TA.2.3 Burst confettis sur task complete (`71f37b7`)

### Étape 3 — Voice IN/OUT pour Le Professeur (TB.3 + TB.4)

En deux temps :

1. **TB.4 TTS d'abord** (1.5j) — `window.speechSynthesis` ou Coqui local. Faible risque, validation rapide que le Professeur "a une voix".
2. **TB.3 STT ensuite** (2-3j) — Web Speech API (cloud Google) OU Whisper.cpp wasm (local, plus lourd mais privacy-first et aligné avec le positionnement du dashboard local).

UX cible : aller chercher un café en parlant à son agent.

### Étape 4 — Map polish (thème A partiel)

5 jours **time-boxés**. Livrables précis avant de démarrer :
- 1-2 nouvelles maisons / bâtiments thématiques (forge ? bibliothèque ?)
- Objets interactifs (panneau routines TC.3, whiteboard, imprimante)
- Pass sprites custom (TA.6)
- Décorations jardin

---

## Reliquats Phase 1-2 (gardés pour mémoire)

Stories du backlog originel encore ouvertes. Soit reportées au launch (cf STRATEGY.md), soit candidates aux thèmes ci-dessous.

| ID | Story | Verdict |
|---|---|---|
| S4.3 | Vidéo demo 90s | → STRATEGY.md (remplacée par Loom au launch) |
| S4.5 | Public GitHub release + Show HN | → STRATEGY.md (Sprint Launch) |
| S6.1 | tmux send-keys fallback | **Tué** — pivot terminal overlay couvre 95 % du besoin |
| S6.4 | Politique sessions externes | **Tué** — même raison |
| S7.4 | Notarisation macOS Developer ID | → STRATEGY.md (avant beta publique) |
| S7.5 | Comportement par statut → POIs par maison | → **TA.4** (theme Game dev) |
| S7.6 | Panneau Scheduled routines | → **TC.3** (theme Workspace intel) |
| PT.6 | ESLint + CI | **Tué** — strict TS suffit en solo dev. Ressort si on hire. |

---

## Thèmes actifs

Six thèmes. Chaque thème = un sandbox cohérent. On peut bosser sur plusieurs en parallèle ou se concentrer sur un seul, comme on veut.

### Thème A — Game dev & Phaser avancé

Skill : graphisme 2D, shaders, animation, game feel.

- [ ] **TA.1** Day/night cycle dynamique
  - Cycle 24h compressé en 30min réel
  - Overlay lumière douce + ambiance changeante (palette filter)
  - Lampadaires qui s'allument la nuit dans le jardin
  - **Apprentissage** : Phaser pipelines, post-processing, color grading
- [x] **TA.2** Particle effects sur status change — livré 2026-05-30
  - ✅ Sparkles violets sur `coding` (`c609fe0`)
  - ✅ Smoke gris sur `blocked` (`a387b87`)
  - ✅ Burst confettis sur task complete (`71f37b7`)
  - Reportés (parking lot) : étoiles dorées sur `awaiting_approval`, trail derrière le player, smoke sur idle long
  - Apprentissage acquis : Phaser ParticleEmitter (continuous + explode), generateTexture pour assets procéduraux, blendMode ADD/NORMAL, gravity/angle/scale/alpha curves
- [ ] **TA.3** Shaders custom (GLSL)
  - Water shader pour la fontaine du jardin
  - Outline pixel-perfect autour de l'agent actif
  - Distortion heat-shimmer au-dessus des desks "running_tool"
  - **Apprentissage** : GLSL, Phaser pipeline API
- [ ] **TA.4** POIs par statut (ex-S7.5)
  - POIs dans chaque maison : `kanban_board`, `coding_desk`, `monitor_wall`, `meeting_table`, `coffee_corner`
  - Mapping : `planning`/`awaiting_approval` → board ; `coding` (Edit/Write) → desk ; `running_tool` → desk ; `idle` → coffee_corner ; `awaiting_input` → board avec `?`
  - NpcManager.wander étendu pour préférer le POI lié au statut
  - **Apprentissage** : design pattern state machine + spatial AI
- [ ] **TA.5** Camera cinematic mode
  - Quand un agent finit un long task : zoom dramatique + fade-in d'un "🎉 task complete" banner
  - Letterbox bars + slow pan quand le Professeur parle
  - **Apprentissage** : Phaser camera FX, tween chains
- [ ] **TA.6** Sprite customization
  - Le user peut choisir son skin player (sélecteur dans Settings)
  - Pack de 6-8 sprites Pipoya alternatives
  - **Apprentissage** : asset management, persistance config
- [ ] **TA.7** Mini-map
  - Vue zoom-out coin haut-droit, toujours visible, dots colorés par agent status
  - Cliquable pour téléport caméra
  - **Apprentissage** : Phaser render texture, multi-camera
- [ ] **TA.8** Sound design
  - SFX subtils : footsteps, "ping" notification, "thunk" plan rejected
  - Musique d'ambiance lo-fi en loop (toggle on/off dans Settings)
  - **Apprentissage** : Phaser sound API, audio asset pipeline

### Thème B — Orchestration AI multi-agents

Skill : LLM apps, tool use, agent coordination — directement aligné métier 2026.

- [ ] **TB.1** Le Professeur spawn d'autres agents
  - Le Professeur peut décider de lancer un agent Claude pour une sous-tâche
  - UI : voir le Professeur "appeler" un nouvel NPC sur la map (spawn animation)
  - **Apprentissage** : multi-agent patterns, prompt engineering pour delegation
- [ ] **TB.2** Agent-to-agent dialogues
  - Deux NPCs peuvent se "parler" (le Professeur orchestre, échange info)
  - Bulles de dialogue qui rebondissent entre eux
  - **Apprentissage** : message passing entre processus Claude
- [ ] **TB.3** Voice input pour le Professeur
  - Bouton micro → STT (Web Speech API ou Whisper local) → PTY write
  - **Apprentissage** : Web Speech API, accessibility, latency optim
- [ ] **TB.4** TTS pour les dialogues agents
  - Quand le Professeur parle, voix synthétique (browser TTS ou Coqui local)
  - Voix différentes selon le rôle (architecte = grave, debugger = nerveux)
  - **Apprentissage** : prosody, voice cloning ?
- [ ] **TB.5** Mémoire persistante des agents
  - Chaque NPC garde un journal de bord (markdown) entre sessions
  - Affichable au E (dialogue "Voici ce que j'ai fait la dernière fois")
  - **Apprentissage** : agent memory patterns, vector stores ?
- [ ] **TB.6** Personality cards
  - Chaque agent a une persona (system prompt custom) éditable depuis l'app
  - Templates : "Senior architect", "QA paranoid", "Speed demon", "Yoda mode"
  - **Apprentissage** : prompt design, A/B testing prompts
- [x] **TB.7** FleetView comme MCP server — livré 2026-05-30
  - ✅ 5 tools exposés : `list_agents`, `get_agent_status`, `spawn_agent`, `send_message`, `kill_agent`
  - ✅ Transport HTTP (`/mcp` endpoint mounted dans le serveur principal) — pas de subprocess, pas de path hardcodé, marche en packaging Electron
  - ✅ Wire Professeur : `.mcp.json` auto-écrit au spawn avec port courant + CLAUDE.md mis à jour pour annoncer les tools
  - ✅ Transport stdio resté dispo comme fallback (`npm run mcp`) pour clients ne supportant pas HTTP
  - Apprentissage acquis : protocole MCP, McpServer + StreamableHTTPServerTransport du SDK, hook au statelessmode, `.mcp.json` discovery par Claude Code

### Thème C — Workspace intelligence

Skill : data viz, git internals, transform JSONL → insight.

- [ ] **TC.1** Git overlay par house
  - Badge sur chaque maison : `+12 -3 ⚠ uncommitted` (depuis dernier commit)
  - Animation "leaf" quand un commit est créé en live
  - **Apprentissage** : isomorphic-git ou simple-git, file watching
- [ ] **TC.2** Diff viewer dans terminal overlay
  - Tab "Recent changes" qui liste les fichiers modifiés par la session, click → diff inline
  - **Apprentissage** : diff parsing, monaco editor (?) embedding
- [ ] **TC.3** Panneau Scheduled routines (ex-S7.6)
  - Détection des scheduled tasks (probablement `~/.claude/scheduled-tasks.json` ou via MCP `scheduled-tasks`)
  - `GET /api/routines` : liste avec name / cron / nextRun / lastRun / lastStatus
  - UI : panneau pixel art dans le jardin, animation "fires now" quand une routine déclenche
  - **Apprentissage** : cron parsing, FS watching de répertoires non-projets
- [ ] **TC.4** Replay mode
  - Scrubber temporel en bas : tu rejoues l'historique d'une session JSONL
  - Les NPCs bougent, les bulles de dialogue ressortent
  - **Apprentissage** : timeline UI, event sourcing replay
- [ ] **TC.5** Cost tracker animé
  - Pièces (coins) qui tombent dans une jarre quand un agent dépense des tokens
  - Total visible, alarme rouge au-delà d'un seuil settings
  - **Apprentissage** : data viz ludique, settings reactivity
- [ ] **TC.6** Stats dashboard v2
  - Ajouter : burn rate par jour, top 10 prompts récurrents, ratio plan-accept/reject par projet
  - Drill-down par projet (click sur une maison → stats filtrées)
  - **Apprentissage** : query optimization sur JSONL, charts avancés
- [ ] **TC.7** Session timeline scrubber sur la map
  - Bouton "Show today's history" : les NPCs trail leur position au cours de la journée
  - Heatmap d'activité par house
  - **Apprentissage** : temporal data viz, animation chaining

### Thème D — Performance & scale (skill système)

Skill : profiling, optim, architecture distribuée.

- [ ] **TD.1** 100+ agents à 60fps
  - Stress test : simuler 200 agents avec mock data
  - Identifier les bottlenecks (Phaser update loop ? SSE bandwidth ?)
  - Optims : sprite batching, culling hors-vue, throttle SSE
  - **Apprentissage** : Chrome DevTools profiler, Phaser perf patterns
- [ ] **TD.2** Web Worker pour le parser JSONL
  - Bouger `server/parser.ts` côté browser web worker
  - Décharge le main thread quand 500+ lignes JSONL streamées
  - **Apprentissage** : Web Workers, Comlink, message passing
- [ ] **TD.3** JSONL streaming avec disk cache
  - Pour les gros projets : ne pas relire tout le fichier à chaque démarrage
  - Index byte-offset + dernière ligne lue persistée
  - **Apprentissage** : disk I/O patterns, cache invalidation
- [ ] **TD.4** WebGL particle pool pour scale
  - Si TA.2 (particles) scale mal avec 100+ agents, switch en GPU particles
  - **Apprentissage** : WebGL instancing, GPU compute basics

### Thème E — Platform & extensibility

Skill : architecture plugins, distribution multi-platform.

- [ ] **TE.1** Mobile companion (read-only)
  - QR code pair depuis l'app desktop, browser mobile affiche une vue read-only
  - Cas d'usage : tu cuisines pendant qu'un agent compile, glance rapide sur le tel
  - **Apprentissage** : WebRTC peer-to-peer, responsive design contraint
- [ ] **TE.2** CLI tool `fleet` companion
  - `fleet status` (liste agents en JSON), `fleet kill <id>`, `fleet spawn`
  - Communique avec le serveur embedded via REST
  - **Apprentissage** : CLI design, packaging Node CLI tools (oclif ?)
- [ ] **TE.3** Theme system complet
  - Settings : choisir entre 3-5 themes (pixel-art classic, neon synthwave, terminal green, parchment fantasy)
  - Skins de tilemap + palette + UI
  - **Apprentissage** : design tokens, theming patterns
- [ ] **TE.4** Plugin API (NPCs scriptables)
  - Folder `~/.fleetview/plugins/*.js` chargé au boot
  - API : `onAgentStatusChange`, `onNewSession`, `addCustomNPC`
  - **Apprentissage** : sandboxing, plugin lifecycle, hot reload
- [ ] **TE.5** Tilemap editor in-app
  - Mode édition : drag tiles depuis une palette, sauvegarde le custom layout
  - **Apprentissage** : Phaser tilemaps, undo/redo, serialization
- [ ] **TE.6** Web build (sans Electron)
  - Variant qui tourne dans le browser, JSONL upload manuel (drag-n-drop)
  - Démo zero-install pour curieux
  - **Apprentissage** : feature flags entre Electron/web, file API limits

### Thème F — Multiplayer & social (R&D)

Skill : real-time sync, CRDT, P2P. Plus expérimental.

- [ ] **TF.1** Local WebRTC peer-to-peer
  - Deux machines même wifi : voir les agents de l'autre dans la même map
  - Pas de serveur cloud, NAT traversal via STUN public
  - **Apprentissage** : WebRTC, signaling, CRDTs basiques (yjs ?)
- [ ] **TF.2** Watch mode (read-only stream)
  - Tu donnes un lien à un pote, il voit ta map live (pas d'interaction)
  - **Apprentissage** : tunneling (ngrok-like ?), auth lightweight
- [ ] **TF.3** Cooperative debug mode
  - Deux users contrôlent leur player respectif, peuvent interagir avec les mêmes agents
  - Chat texte intégré
  - **Apprentissage** : conflict resolution, operational transform

---

## Spikes / R&D (1-jour explorations)

Pas une feature, juste explorer une techno. Si ça mène quelque part → on transforme en story dans le thème adéquat.

- [ ] **Spike-GLSL** — Apprendre Phaser pipeline + écrire un shader simple (~1j)
- [ ] **Spike-MCP** — Lire la spec MCP, écrire un serveur minimal qui expose `list_agents` (~1j)
- [ ] **Spike-Whisper** — STT local avec whisper.cpp wasm, mesurer latency (~0.5j)
- [ ] **Spike-Yjs** — Sync deux instances FleetView en local via yjs (~1j)
- [ ] **Spike-Bun** — Tenter de remplacer Node par Bun pour le serveur embedded (~0.5j)

---

## Chantiers transverses

- [x] **PT.1** Mutualiser `STATUS_COLOR`/`STATUS_LABEL` dans `shared/agent-ui.ts` — fait dans S1.1.A (commit 56faa62)
- [ ] **PT.2** Bus factor : code propre + ADRs + docs continus (continu, pas une story)
- [x] **PT.5** Split `NpcManager` (685 → 444 lignes) : `CharacterSpriteFactory` extrait — livré 2026-05-30 (`e578fa9`)

---

## Idées dans la salle d'attente

Tu picks si l'envie te prend, sinon ça reste là.

- Animation spawn maison quand 1er agent arrive
- Filtrage sidebar par statut/projet/role
- Click sur projet header pour collapse/expand
- History timeline dans la bulle de dialogue (dernières N actions)
- "Pet" Phaser : un chat qui suit le player et dort quand l'agent est idle
- Achievements/badges (ton premier agent, 100 sessions, etc.)
- Easter eggs (konami code, secret room derrière la fontaine, etc.)
- Capture GIF in-app pour partager une session marquante
- Tutoriel onboarding interactif (player-controlled, premier lancement)

---

## Comment décider quoi prendre

Trois questions guides avant de commencer une story :

1. **Est-ce que ça m'amuse ?** (sinon → suivante)
2. **Est-ce que ça m'apprend quelque chose que je veux savoir en 2026 ?** (skills LLM, Phaser, real-time, perf — tous OK)
3. **Est-ce que je peux la finir en 1-3 jours ?** (sinon découper)

Pas de pression de finir un thème entier avant le suivant. Pas de pression de livrer dans un ordre. Le seul "engagement" : continuer à faire `tsc --noEmit` propre + 68/68 tests verts à chaque commit.

---

## Décisions PO récentes

### 2026-05-24 — Triage initial sur 4 idées remontées par dogfooding

| Idée | Décision |
|---|---|
| Fenêtre de contexte pour parler / approuver une action | Implémentée — terminal overlay + approval widget (Sprint 5-7). |
| Améliorer le pathfinding (blocage dans les murs) | Implémentée — S2.5 A* grid-based. |
| Comportement par statut → lieu | Reporté → TA.4. |
| Tâches planifiées sur la map | Reporté → TC.3. |

### 2026-05-30 — Pivot mode terrain de jeu solo

Après le bilan PM post-Sprint 8, on assume consciemment de ne pas lancer. Le projet sert au skill-building solo pour l'instant. La roadmap business (Phases 3-5 originales) est parquée dans [STRATEGY.md](STRATEGY.md), à ressortir le jour où on switch en mode "ship". Le backlog est réorganisé par thèmes au lieu de phases.
