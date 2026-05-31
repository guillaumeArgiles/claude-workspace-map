import { useEffect, useState } from "react";
import type { AppConfig, Locale } from "../../shared/config-schema";
import { SUPPORTED_LOCALES } from "../../shared/config-schema";
import { useTranslation } from "../i18n";

interface SettingsPanelProps {
  config: AppConfig;
  onClose: () => void;
  onChange: (config: AppConfig) => void;
}

export function SettingsPanel({ config, onClose, onChange }: SettingsPanelProps) {
  const { t, setLocale } = useTranslation();
  const [local, setLocal] = useState<AppConfig>(config);
  const [saving, setSaving] = useState(false);

  // Live preview on every local change. Locale is mirrored into the i18n
  // module so the rest of the UI re-renders in the chosen language before
  // the user has saved.
  useEffect(() => {
    onChange(local);
    setLocale(local.locale);
  }, [local]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setLocale(saved.locale);
      onClose();
    } catch (err) {
      console.error("Failed to save config:", err);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    onChange(config); // revert live preview to original
    setLocale(config.locale);
    onClose();
  }

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) handleCancel();
  }

  return (
    <div id="settings-panel-backdrop" onClick={handleBackdrop}>
      <div id="settings-panel">
        <header>
          <h3>{t("settings.title")}</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </header>

        <span className="settings-label">{t("settings.theme")}</span>
        <div className="settings-toggle">
          <button
            className={local.theme === "dark" ? "active" : ""}
            onClick={() => setLocal((p) => ({ ...p, theme: "dark" }))}
          >
            {t("settings.theme.dark")}
          </button>
          <button
            className={local.theme === "light" ? "active" : ""}
            onClick={() => setLocal((p) => ({ ...p, theme: "light" }))}
          >
            {t("settings.theme.light")}
          </button>
        </div>

        <span className="settings-label">{t("settings.language")}</span>
        <div className="settings-toggle">
          {SUPPORTED_LOCALES.map((loc) => (
            <button
              key={loc}
              className={local.locale === loc ? "active" : ""}
              onClick={() => setLocal((p) => ({ ...p, locale: loc as Locale }))}
            >
              {t(`settings.language.${loc}`)}
            </button>
          ))}
        </div>

        <span className="settings-label">{t("settings.sidebar_width")}</span>
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

        <span className="settings-label">{t("settings.voice")}</span>
        <div className="settings-toggle">
          <button
            className={local.voiceEnabled ? "active" : ""}
            onClick={() => setLocal((p) => ({ ...p, voiceEnabled: true }))}
          >
            {t("settings.voice.on")}
          </button>
          <button
            className={!local.voiceEnabled ? "active" : ""}
            onClick={() => setLocal((p) => ({ ...p, voiceEnabled: false }))}
          >
            {t("settings.voice.off")}
          </button>
        </div>
        <span className="settings-note">{t("settings.voice.note")}</span>

        <span className="settings-label">{t("settings.server_port")}</span>
        <div>
          <span className="settings-port">{config.port}</span>
          <span className="settings-note">{t("settings.note.restart")}</span>
        </div>

        <div className="settings-actions">
          <button className="cancel-btn" onClick={handleCancel}>
            {t("settings.cancel")}
          </button>
          <button className="spawn-btn" onClick={save} disabled={saving}>
            {saving ? t("settings.saving") : t("settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
