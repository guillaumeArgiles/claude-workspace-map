import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { MapScene } from "./game/scenes/MapScene";
import { AgentSidebar } from "./components/AgentSidebar";
import { SettingsPanel } from "./components/SettingsPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CmdKHint } from "./components/CmdKHint";
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (!mountRef.current || gameRef.current) return;

    const initialRect = mountRef.current.getBoundingClientRect();
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: mountRef.current,
      width: Math.round(initialRect.width),
      height: Math.round(initialRect.height),
      backgroundColor: "#1a1a1a",
      pixelArt: true,
      roundPixels: true,
      physics: {
        default: "arcade",
        arcade: { debug: false },
      },
      scale: {
        // NONE: we manage canvas size ourselves via scale.resize() (see the
        // sidebar-toggle effect below and the window-resize listener). RESIZE
        // mode reads window dimensions in some configurations, so it ignores
        // the parent shrinking when the sidebar opens.
        mode: Phaser.Scale.NONE,
        autoCenter: Phaser.Scale.NO_CENTER,
      },
      scene: [MapScene],
    });

    // Keep the canvas in lock-step with #game-mount via a ResizeObserver.
    // Covers BOTH the sidebar toggle (mount width changes) AND native window
    // resizes. More reliable than relying on Phaser's auto scale modes.
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !gameRef.current) return;
      const cr = entry.contentRect;
      const w = Math.round(cr.width);
      const h = Math.round(cr.height);
      if (w === 0 || h === 0) return;
      gameRef.current.scale.resize(w, h);
    });
    resizeObserver.observe(mountRef.current);

    gameRef.current = game;
    return () => {
      resizeObserver.disconnect();
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

  // (Sidebar toggle reflow is handled by the ResizeObserver above.)

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
      <CmdKHint hidden={!sidebarCollapsed} />
    </>
  );
}
