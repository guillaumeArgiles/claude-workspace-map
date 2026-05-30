import { useEffect, useState } from "react";
import type { AppConfig } from "../../shared/config-schema";

interface SettingsPanelProps {
  config: AppConfig;
  onClose: () => void;
  onChange: (config: AppConfig) => void;
}

export function SettingsPanel({ config, onClose, onChange }: SettingsPanelProps) {
  const [local, setLocal] = useState<AppConfig>(config);
  const [saving, setSaving] = useState(false);

  // Live preview on every local change
  useEffect(() => { onChange(local); }, [local]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(local),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = (await res.json()) as AppConfig;
      onChange(saved);
      onClose();
    } catch (err) {
      console.error("Failed to save config:", err);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    onChange(config); // revert live preview to original
    onClose();
  }

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) handleCancel();
  }

  return (
    <div id="settings-panel-backdrop" onClick={handleBackdrop}>
      <div id="settings-panel">
        <header>
          <h3>Settings</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </header>

        <span className="settings-label">Theme</span>
        <div className="settings-toggle">
          <button
            className={local.theme === "dark" ? "active" : ""}
            onClick={() => setLocal((p) => ({ ...p, theme: "dark" }))}
          >
            Dark
          </button>
          <button
            className={local.theme === "light" ? "active" : ""}
            onClick={() => setLocal((p) => ({ ...p, theme: "light" }))}
          >
            Light
          </button>
        </div>

        <span className="settings-label">Sidebar width</span>
        <div className="settings-slider-row">
          <input
            type="range"
            min={200}
            max={600}
            value={local.sidebarWidth}
            onChange={(e) =>
              setLocal((p) => ({ ...p, sidebarWidth: Number(e.target.value) }))
            }
          />
          <span className="settings-slider-val">{local.sidebarWidth}px</span>
        </div>

        <span className="settings-label">Server port</span>
        <div>
          <span className="settings-port">{config.port}</span>
          <span className="settings-note">restart required to change</span>
        </div>

        <div className="settings-actions">
          <button className="cancel-btn" onClick={handleCancel}>
            Cancel
          </button>
          <button className="spawn-btn" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
