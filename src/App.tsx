import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { MapScene } from "./game/scenes/MapScene";
import { AgentSidebar } from "./components/AgentSidebar";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatsDashboard } from "./components/StatsDashboard";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CmdKHint } from "./components/CmdKHint";
import { uiBus } from "./game/services/uiBus";
import { I18nProvider, detectLocale, setLocale, useTranslation } from "./i18n";
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
  // The locale is owned by I18nProvider; AppShell uses it via useTranslation.
  // We render the provider with a navigator-detected locale immediately, then
  // align it with the persisted config locale once /api/config returns.
  return (
    <I18nProvider initialLocale={detectLocale()}>
      <AppShell />
    </I18nProvider>
  );
}

function AppShell() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showStats, setShowStats] = useState(false);
  // Tracks open Phaser-side modals (RPGAgentMenuUI, RPGApprovalUI) so we can
  // hide the floating ⌘K banner — otherwise it overlaps the bottom of the menu.
  const [phaserModalDepth, setPhaserModalDepth] = useState(0);
  const { t } = useTranslation();

  useEffect(() => {
    const onModalChange = ({ open }: { open: boolean }) => {
      setPhaserModalDepth((d) => Math.max(0, d + (open ? 1 : -1)));
    };
    uiBus.on("modal_open_changed", onModalChange);
    return () => uiBus.off("modal_open_changed", onModalChange);
  }, []);

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
    // DEBUG: expose le game pour inspection depuis la console (et Claude in Chrome).
    // Bénin en prod (1 ref de plus sur window), pratique en dev. À retirer si
    // souci de surface d'attaque sur une build publique.
    (window as unknown as { __game?: Phaser.Game }).__game = game;

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

  // Fetch config on mount and apply theme + locale
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg: AppConfig) => {
        setConfig(cfg);
        applyTheme(cfg);
        setLocale(cfg.locale);
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
                <h2>{t("sidebar.title")}</h2>
              </header>
              <div className="boundary-fallback">
                <p>{t("sidebar.fallback.title")}</p>
                <code>{err.message}</code>
                <button onClick={reset}>{t("sidebar.fallback.retry")}</button>
              </div>
            </aside>
          )}
        >
          <AgentSidebar
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed((c) => !c)}
            onOpenSettings={() => setShowSettings(true)}
            onOpenStats={() => setShowStats(true)}
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
      {showStats && <StatsDashboard onClose={() => setShowStats(false)} />}
      <CmdKHint
        hidden={
          !sidebarCollapsed || showStats || showSettings || phaserModalDepth > 0
        }
      />
    </>
  );
}
