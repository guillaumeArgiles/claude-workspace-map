# Stratégie produit & launch — Claude Workspace Map

**Statut** : parking lot. Le projet est actuellement en **mode terrain de jeu solo** ([BACKLOG.md](BACKLOG.md)). Ce document conserve la stratégie produit pour le jour où on décide de lancer publiquement.

Écrit le 2026-05-30 après l'analyse PM post-Sprint 8.

---

## TL;DR

Le code est techniquement propre, **zéro user externe**, la roadmap originale projetait un exit Anthropic à M12 alors qu'on est à M0 (pas une seule install publique).

Le risque dominant n'est plus la qualité du code — c'est de continuer à polir un produit dont personne ne veut. **Plus on retarde le launch, plus chaque feature ajoutée est un pari sur des hypothèses non testées.**

Pour l'instant on assume ce risque consciemment : le projet sert au skill-building solo. Ce document existe pour qu'on n'ait pas à re-réfléchir le jour où on bascule en mode "ship".

---

## Principes PM qui s'appliqueront le jour du switch

1. **Coût d'opportunité** — chaque semaine sans user externe = semaine de code aveugle.
2. **Demi-vie de la planification** — toute roadmap au-delà de 2 mois est de la fiction. À réécrire avec des données réelles.
3. **L'exit Anthropic n'arrive pas en planifiant un exit Anthropic** — il arrive en construisant un truc qu'ils veulent acquérir. L'ordre des opérations compte : produit → users → traction → conversations.

---

## Quand re-déclencher cette stratégie

Critères qui justifient de sortir de "mode playground" et passer en "mode launch" :

- L'utilisateur (Guillaume) sent que les features qu'il a envie de construire pour s'amuser sont à court d'idées
- OU le code est sorti d'usage personnel (3+ semaines sans dogfooding actif)
- OU quelqu'un d'extérieur (collègue, ami dev) demande un accès
- OU Anthropic sort une feature qui rend FleetView soit caduc soit clairement complémentaire (signal de marché)

Tant qu'aucun de ces critères n'est rempli, rester en mode playground.

---

## Ce qu'il faut supprimer du backlog au moment du switch

Tout ce qui présuppose des users qu'on n'a pas :

| Élément | Pourquoi |
|---|---|
| **Sprints 9-12** (auth, cloud, pricing, marketing push) | Phase 3 suppose de la traction. Pas de traction → pas de phase 3. |
| **Sprints 13-18** (intégrations Slack/Discord/GitHub, scale, presse) | Features pour des équipes qu'on n'a pas. |
| **Sprints 19-24** (due diligence, M&A, closing) | Procrastination déguisée en planification tant que pas de signal. |
| **S7.6 Panneau Scheduled routines** | Niche. À garder seulement si feedback users le réclame. |
| **PT.6 ESLint** | Strict TS suffit pour un solo dev. À ressortir si on hire. |

À garder en mémo *dans ce fichier*, pas dans le backlog opérationnel.

---

## Sprint 9 (le vrai) — Launch playbook

**Phase** : 3 — Validation produit
**Goal** : sortir le produit en public, récupérer du feedback réel.
**Budget** : 5 jours dev sur 7j calendaires.

### Stories

| ID | Story | Effort | Notes |
|---|---|---|---|
| L.1 | GitHub Release v0.2.0 + binaires macOS/Linux | 0.5j | Tag `v0.1.0` existe, suffit de pousser. `release.yml` génère les binaires. |
| L.2 | Signature macOS ad-hoc + warning Gatekeeper documenté dans README | 0.5j | Notarisation propre (S7.4) peut attendre, ad-hoc débloque la beta. |
| L.3 | Loom 90s (remplace S4.3 "vidéo demo") | 0.5j | Zero montage. Walkthrough naturel, voix off, capture écran. |
| L.4 | Landing déployée sur `claude-workspace.dev` (ou subdomain GitHub Pages) | 0.5j | Astro / Vite static — la page existe (`da5f023`), suffit de host. |
| L.5 | Feedback channel léger | 0.5j | Tally form intégré dans Settings + lien GitHub Issues. Pas de Mixpanel/Posthog encore. |
| L.6 | Compatibility manifest | 0.5j | Documenter quelles versions Claude Code FleetView supporte. Test de smoke à chaque release upstream (cf bug v2.1.x). |
| L.7 | Posts launch | 1j | (a) Show HN, (b) post Claude Code Discord, (c) tweet thread avec @AnthropicAI mention, (d) post r/ClaudeAI. |
| L.8 | README polish final | 0.5j | Section "Download" en haut, demo GIF (extrait Loom), badge GitHub stars / discord. |

### Definition of Done

- Binaires téléchargeables depuis GitHub Releases
- Landing live avec lien download
- 1 post HN actif (peu importe le score initial)
- 1 post Discord Claude Code
- Feedback channel testé bout-en-bout

---

## Sprint 10 — User research + bug-fix rapide

**Phase** : 3
**Goal** : convertir les premières installs en données qualitatives. Fixer les bugs critiques avant qu'ils ne déçoivent.
**Budget** : 2 semaines calendaires (le sprint commence à J+0 du launch).

### Activités

- **5 entretiens user 30min** dans les 14 jours post-launch
  - Question centrale : *"Tu utilises FleetView pour quoi exactement ?"*
  - Détermine si l'hypothèse "Talk to Agents" tient OU si les gens viennent pour la map seule.
- **Triage quotidien des issues GitHub** + Tally responses
- **Bug-fix rolling release** — patch versions v0.2.x au fil de l'eau
- **Tableau de bord lecture seule** : nb installs (proxy : downloads GitHub), nb retours feedback, top 3 pains

### Anti-pattern à éviter

Ne **pas** ajouter de feature pendant ce sprint. Bug-fix only. La tentation sera énorme : la résister.

---

## Decision gate post-launch (J+30)

Document court à écrire au début du Sprint 9, **avant** d'avoir les données. Critère public, pas révisable a posteriori.

```
Si à J+30 on a :
- < 50 GitHub stars
- < 10 installs estimées
- < 3 conversations user qualifiées (≥ 20min)

→ On RANGE le projet, retour mode playground OU pivot total.

Sinon :
- 50-200 stars / 10-50 installs / 3-10 conversations → Sprint 11 (itérer sur signal)
- > 200 stars / > 50 installs / > 10 conversations → Phase 4 (monétisation)
```

Le seuil arbitraire est OK — l'important est de **fixer le critère avant** pour s'empêcher d'auto-justifier après.

---

## Sprint 11+ — À écrire APRÈS le gate

Ne **pas** planifier maintenant. Ce qu'on écrirait aujourd'hui sera obsolète après J+30.

Pistes envisagées (à valider/invalider par le feedback) :

- **Si signal "team mode"** → reprendre Sprint 9 original (auth + cloud sync)
- **Si signal "single-user power tool"** → doubler sur PTY orchestration (Le Professeur étendu, multi-agent workflows)
- **Si signal "observabilité"** → doubler sur stats dashboard + intégrations (Slack/Discord notif)
- **Si pas de signal clair** → ranger le projet 6 mois, observer le marché Claude Code, revenir avec un angle plus précis.

---

## Visibilité Anthropic — à activer dès le launch

Pas "S12.4 contact DevRel à M12". **Au moment du launch**, coût zéro :

- Tag `@AnthropicAI` sur le tweet thread
- Post dans le Discord Claude Code (channel `#showcase` ou équivalent)
- Mention "Built with Claude Code" dans le README + landing
- Si Anthropic a un repo "awesome-claude-code" → PR pour s'y ajouter
- Si un employé Anthropic engage publiquement → engager poliment, pas de pitch

Objectif : être sur le radar, pas vendre. La conversation business arrive plus tard, et seulement si la traction la justifie.

---

## Hypothèses produit à valider

Le launch et le research servent à valider ou invalider ces 4 hypothèses :

| # | Hypothèse | Comment on la valide |
|---|---|---|
| H1 | Les devs solo qui utilisent Claude Code veulent une vue map | Adoption initiale > 10 installs sans churn immédiat |
| H2 | Ils installent un desktop app pour ça (vs SaaS) | Ratio download/landing visits > 5% |
| H3 | "Talk to Agents" depuis la map est le différenciateur clé | ≥ 3 des 5 entretiens mentionnent le terminal overlay / palette spontanément |
| H4 | Des équipes paieraient | Au moins 1 conversation entretien où le user mentionne vouloir partager avec son équipe |

Si H1+H2 cassent → ranger / pivoter.
Si H1+H2 OK mais H3 casse → repenser la proposition de valeur.
Si H1+H2+H3 OK mais H4 casse → produit gratuit / open-source à vie, pas de Phase 3.
Si tout OK → Phase 3.

---

## Reliquats techniques bloquants pour le launch

Ces stories ne sont **pas** dans le backlog playground (qui assume mode solo) mais devront être faites avant le launch :

- **S4.5** GitHub Release publié (binaries auto-buildés par `release.yml` existant)
- **S4.3** Vidéo demo — remplacée par Loom 90s (cf L.3)
- **S7.4** Notarisation macOS — version ad-hoc OK pour la beta, notarisation propre quand on a budget Apple Developer ID
- **L.6** Compatibility manifest Claude Code (post-mortem bug v2.1.x à formaliser)
