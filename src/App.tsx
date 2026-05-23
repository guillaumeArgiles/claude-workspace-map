import { useEffect, useRef } from "react";
import Phaser from "phaser";
import { GRID } from "./game/config/grid";
import { MapScene } from "./game/scenes/MapScene";

export function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!mountRef.current || gameRef.current) return;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: mountRef.current,
      width: GRID.width,
      height: GRID.height,
      backgroundColor: "#1a1a1a",
      pixelArt: true,
      roundPixels: true,
      physics: {
        default: "arcade",
        arcade: { debug: false },
      },
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: [MapScene],
    });

    gameRef.current = game;
    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  return (
    <div id="app-shell">
      <div id="game-mount" ref={mountRef} style={{ width: GRID.width, maxWidth: "100%" }} />
    </div>
  );
}
