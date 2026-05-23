# Architecture Decision Records

Chaque décision technique non-triviale (≥1 jour d'effort à défaire) est écrite ici.

Format inspiré de [Michael Nygard's template](https://github.com/joelparkerhenderson/architecture-decision-record).

## Conventions

- Fichier : `NNNN-titre-en-kebab-case.md` (NNNN = numéro séquentiel sur 4 chiffres)
- Statuts : `Proposed` → `Accepted` → `Superseded by ADR-XXXX` ou `Deprecated`
- Si un ADR est superseded, on garde le fichier et on ajoute un lien vers le successeur

## Index

| ID | Titre | Statut | Date |
|---|---|---|---|
| _0001_ | _PTY wrap pour l'interaction agent_ | _à venir (story S1.5)_ | _-_ |

## Template

```markdown
# ADR NNNN — Titre court

- Date : YYYY-MM-DD
- Statut : Proposed | Accepted | Superseded | Deprecated

## Contexte

Quelle situation nous force à choisir ? Quelles contraintes ?

## Options envisagées

- Option A — pros / cons
- Option B — pros / cons
- Option C — pros / cons

## Décision

Quelle option on retient et pourquoi.

## Conséquences

- Positives : ...
- Négatives : ...
- À surveiller : ...

## Références

Liens code / issues / docs externes.
```
