import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { MapScene } from "./game/scenes/MapScene";
import { AgentSidebar } from "./components/AgentSidebar";
import { ErrorBoundary } from "./components/ErrorBoundary";

export function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    if (!mountRef.current || gameRef.current) return;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: mountRef.current,
      // width/height omitted — RESIZE mode fills the parent container exactly,
      // so the canvas never overflows and map edges are always reachable by
      // scrolling the camera to the bounds.
      backgroundColor: "#1a1a1a",
      pixelArt: true,
      roundPixels: true,
      physics: {
        default: "arcade",
        arcade: { debug: false },
      },
      scale: {
        // RESIZE: canvas = container size, no scaling, no overflow.
        // Camera zoom + setBounds (in MapScene) handle what's visible.
        mode: Phaser.Scale.RESIZE,
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
      <ErrorBoundary
        label="AgentSidebar"
        fallback={(err, reset) => (
          <aside id="agent-sidebar" className="errored">
            <header>
              <span className="dot ko" />
              <h2>Live Claude sessions</h2>
            </header>
            <div className="boundary-fallback">
              <p>The sidebar crashed.</p>
              <code>{err.message}</code>
              <button onClick={reset}>Retry</button>
            </div>
          </aside>
        )}
      >
        <AgentSidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((c) => !c)}
        />
      </ErrorBoundary>
    </div>
  );
}
