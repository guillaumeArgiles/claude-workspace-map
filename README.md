# AI Agent Workspace — Map

Carte pixel art rendue dans Phaser 3 (React + Vite + TypeScript).

## Approche

L'image de référence (`public/assets/background.png`) est utilisée telle quelle
comme fond du canvas. La grille logique 20×12 (cellules de 72 px = 1440×864) reste
disponible côté code pour ajouter ultérieurement :

- des zones de collision invisibles,
- des sprites d'agents par-dessus,
- des bulles de discussion / UI overlays,
- du pathfinding.

## Démarrer

```bash
npm install
npm run dev   # → http://localhost:5173
```

Ajouter `?grid` à l'URL pour afficher une grille de debug 20×12 par-dessus.

## Structure

```
public/assets/background.png      # image de fond unique
src/main.tsx                      # entry React
src/App.tsx                       # monte le canvas Phaser
src/game/config/grid.ts           # constantes grille + helpers cellule→pixel
src/game/scenes/MapScene.ts       # rendu : background + grille optionnelle
```

## Remplacer l'image

Écrase `public/assets/background.png`. Le canvas est en 1440×864 et l'image est
étirée pour le remplir — choisis une image proche du ratio 5:3 pour éviter la
distorsion.
