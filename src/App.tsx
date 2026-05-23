import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { GRID } from "./game/config/grid";
import { MapScene } from "./game/scenes/MapScene";
import { AgentSidebar } from "./components/AgentSidebar";

export function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
        // ENVELOP scales the canvas so the *smaller* dimension fills the
        // container and the larger one overflows — combined with camera bounds
        // we never see dark letterbox bars; we just crop a little of the map
        // when the viewport aspect doesn't match 5:3.
        mode: Phaser.Scale.ENVELOP,
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

  // Tell Phaser to recompute its display size when the sidebar toggles, so the
  // canvas reflows to the new available width instead of staying squashed.
  useEffect(() => {
    const id = window.setTimeout(() => gameRef.current?.scale.refresh(), 250);
    return () => window.clearTimeout(id);
  }, [sidebarCollapsed]);

  return (
    <div id="app-shell" className={sidebarCollapsed ? "sidebar-collapsed" : ""}>
      <div id="game-mount" ref={mountRef} />
      <AgentSidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
      />
    </div>
  );
}
