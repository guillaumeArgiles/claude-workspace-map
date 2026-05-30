import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { MapScene } from "./game/scenes/MapScene";
import { AgentSidebar } from "./components/AgentSidebar";
import { SettingsPanel } from "./components/SettingsPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import type { AppConfig } from "../shared/config-schema";

function applyTheme(cfg: AppConfig) {
  const root = document.documentElement;
  const d = cfg.theme === "dark";
  root.style.setProperty("--bg-primary",    d ? "#0d1117" : "#f5f7fa");
  root.style.setProperty("--bg-secondary",  d ? "#111418" : "#ffffff");
  root.style.setProperty("--bg-hover",      d ? "#171d27" : "#e8edf5");
  root.style.setProperty("--bg-surface",    d ? "#1a1f27" : "#eef1f6");
  root.style.setProperty("--border",        d ? "#2c313a" : "#d1d5db");
  root.style.setProperty("--border-accent", d ? "#1a2744" : "#bfcbe0");
  root.style.setProperty("--text-primary",  d ? "#eeeeee" : "#111827");
  root.style.setProperty("--text-muted",       d ? "#9ca3af" : "#6b7280");
  root.style.setProperty("--bg-header-start",  d ? "#131c30" : "#e8edf5");
  root.style.setProperty("--sidebar-w",        `${cfg.sidebarWidth}px`);
}

export function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);

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

  // Fetch config on mount and apply theme
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg: AppConfig) => {
        setConfig(cfg);
        applyTheme(cfg);
      })
      .catch(() => {});
  }, []);

  // Tell Phaser to recompute its display size when the sidebar toggles, so the
  // canvas reflows to the new available width instead of staying squashed.
  useEffect(() => {
    const id = window.setTimeout(() => gameRef.current?.scale.refresh(), 250);
    return () => window.clearTimeout(id);
  }, [sidebarCollapsed]);

  return (
    <>
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
            onOpenSettings={() => setShowSettings(true)}
          />
        </ErrorBoundary>
      </div>
      {showSettings && config && (
        <SettingsPanel
          config={config}
          onClose={() => { setShowSettings(false); }}
          onChange={(cfg) => { setConfig(cfg); applyTheme(cfg); }}
        />
      )}
    </>
  );
}
