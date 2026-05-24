# ADR 0001 — PTY wrap pour l'interaction avec les sessions Claude Code

- Date : 2026-05-24
- Statut : Accepted

## Contexte

Le widget observe les sessions Claude Code en tail-ant `~/.claude/projects/**/*.jsonl` et en exposant ces événements via SSE. C'est suffisant pour **lire** ce que Claude fait, mais le produit a besoin de **bidirectionnalité** pour atteindre son wow moment d'acquisition Anthropic :

- envoyer un message à une session existante (équivalent du user qui tape dans le terminal),
- répondre à un `ExitPlanMode` (Approve / Reject / Edit) sans changer de fenêtre,
- répondre à un `AskUserQuestion` depuis le widget,
- répondre à un `Notification` (idle prompt, permission) directement.

Cette décision concerne le bloc technique principal de la Phase 2 de la roadmap (Sprint 5-7, story S5.1 et suivantes).

## Options envisagées

### A. API HTTP / IPC officielle Claude Code

Pas faisable en mai 2026. Claude Code n'expose aucune surface bidirectionnelle. Les hooks (Notification, PreToolUse, PostToolUse, Stop, SessionEnd…) sont **unidirectionnels** : Claude → script, jamais script → Claude. La sortie JSON d'un hook peut au mieux bloquer ou modifier le tool call, pas injecter un user prompt.

Le MCP est réactif (Claude appelle nos outils), pas proactif. L'Agent SDK / Managed Agents crée **de nouvelles** instances, pas un canal vers une session existante.

→ Pas une option à court terme. À surveiller comme feature request future à Anthropic.

### B. Manipulation directe des fichiers JSONL

Écrire une nouvelle ligne `user` dans le `.jsonl` d'une session active. Sur le papier ça pourrait simuler une entrée user.

Problèmes :
- collisions d'écriture avec Claude qui écrit en parallèle sur le même fichier,
- aucune garantie que Claude relise le fichier en cours de session (rien n'indique qu'il poll en lecture),
- les entrées `queue-operation` qu'on voit dans les JSONL sont du metadata interne, pas une input queue,
- corruption d'un fichier de session ferait perdre l'historique d'un user.

→ **Trop risqué.** Killed.

### C. tmux send-keys sur sessions existantes externes

Si la session Claude tourne déjà dans une fenêtre tmux, on peut s'y attacher (`tmux send-keys -t <session> "user prompt" Enter`).

Avantages :
- Aucune modification de Claude Code.
- Léger (~6-8h pour détecter + s'attacher).

Inconvénients :
- Ne marche **que** pour les users qui lancent Claude dans tmux. Les users qui utilisent iTerm directement ou WezTerm sans multiplexer sont exclus.
- Plus risqué : race conditions si l'utilisateur tape en parallèle, pas de garantie que la session est encore vivante au moment du `send-keys`.
- Casse silencieusement si l'utilisateur switch de fenêtre / ferme tmux.

→ Bon plan B mais pas suffisant comme cible principale.

### D. PTY wrap : le widget devient le launcher (RETENU)

Le widget intègre `node-pty` et **lance lui-même** les sessions Claude Code dans un pseudo-terminal qu'il contrôle de bout en bout :
- on connaît le `pid`, on peut tuer la session proprement,
- on écrit dans le stdin via `pty.write()`,
- on lit le stdout en stream (mais on continue surtout à parser le JSONL pour l'état riche),
- on capture l'`exit` pour libérer la house.

L'UI propose un bouton **"Spawn Claude here"** dans chaque maison libre + un **"New session"** dans la sidebar avec sélecteur de projet (récents + browse). Les sessions externes (lancées en CLI sans passer par le widget) restent observables en read-only avec un fallback : option de les **re-lancer** dans un PTY contrôlé (le widget kill l'ancienne et restart), ou bien `tmux send-keys` si on détecte le wrapper tmux (combinaison avec C).

## Décision

**On retient D.** Le widget passe d'observateur à launcher pour atteindre le wow moment. C est gardée en fallback opportuniste pour les users tmux qui veulent garder leur workflow CLI existant.

## Conséquences

### Positives

- Une seule architecture supportée pour la majorité des users — pas de prérequis tmux.
- Contrôle complet du PTY : on peut faire des assertions sur les sessions (exit code, timeout, redémarrage).
- Source de vérité claire pour l'UI : le widget connaît exactement quelles sessions il a lancées et lesquelles sont externes.
- Synergie acquisition : Anthropic peut intégrer cette couche dans une future "Claude Desktop" sans réinventer la roue.

### Négatives

- **Dépendance native** sur `node-pty` (binaire par OS + arch). Impact sur le packaging Electron (Sprint 3) : il faut prebuild les binaires pour macOS arm64 / x64 et Linux x64.
- Le widget devient critique : si il crashe, les sessions Claude qu'il a lancées meurent avec lui. Mitigation : `detached: true` sur le spawn + reconnexion possible au PID.
- Le wrap est **fragile aux changements internes de Claude Code** : si l'UI du REPL change (séquences ANSI, slash commands, prompts), `pty.write()` peut envoyer la mauvaise chose. Mitigation :
  - Abstraction `AgentInjector` qui isole la couche send-keys.
  - Tests d'intégration sur chaque version Claude Code (CI matrix).
  - Fallback read-only détecté automatiquement si l'injection rate < seuil.
- Sécurité : on lance un sous-process avec les droits du widget. À auditer en Phase 5 (due diligence). RGPD : les commandes envoyées au PTY transitent par notre code, donc on doit documenter qu'on **ne les logue pas** (et le tenir).

### À surveiller

- **API officielle Anthropic** : si Anthropic publie une `claude --resume <session-id>` ou un socket IPC, on bascule dessus et on déprécie D. ADR de suivi à prévoir.
- **Réception des updates Claude Code** : suivre le changelog officiel et tester avant chaque release stable.

## Références

- Phase 2 de la roadmap : `~/.claude/plans/j-aimerai-d-velopper-ce-projet-joyful-haven.md`
- Backlog Sprint 5 : [docs/BACKLOG.md](../BACKLOG.md#sprint-5--pty-launcher)
- Discussion technique (mai 2026) : audit de faisabilité de la story "Talk to agents" — confirmé que A est inexistant en mai 2026 par revue des docs Claude Code.
