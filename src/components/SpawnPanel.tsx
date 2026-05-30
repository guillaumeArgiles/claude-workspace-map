import { useState } from "react";
import { useTranslation } from "../i18n";

interface SpawnedSession {
  ptyId: string;
  cwd: string;
  spawnedAt: number;
}

interface SpawnPanelProps {
  recentCwds: string[];
  /** Pre-fills the cwd input (e.g. when launching from an existing agent row). */
  defaultCwd?: string;
  onClose: () => void;
  onSpawned: (session: SpawnedSession) => void;
}

export function SpawnPanel({ recentCwds, defaultCwd, onClose, onSpawned }: SpawnPanelProps) {
  const { t } = useTranslation();
  const [cwd, setCwd] = useState(defaultCwd ?? recentCwds[0] ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSpawn() {
    if (!cwd.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: cwd.trim() }),
      });
      const json = await res.json() as { ptyId?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      onSpawned({ ptyId: json.ptyId!, cwd: cwd.trim(), spawnedAt: Date.now() });
      onClose();
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div id="spawn-panel-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div id="spawn-panel">
        <header>
          <h3>{t("spawn.title")}</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </header>

        <label>{t("spawn.cwd")}</label>
        <input
          type="text"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSpawn()}
          placeholder={t("spawn.placeholder")}
          autoFocus
          spellCheck={false}
        />

        {recentCwds.length > 0 && (
          <div className="recent-list">
            <span className="recent-label">{t("spawn.recent")}</span>
            {recentCwds.slice(0, 5).map((d) => (
              <button
                key={d}
                className={`recent-item ${cwd === d ? "active" : ""}`}
                onClick={() => setCwd(d)}
                title={d}
              >
                {shortName(d)}
              </button>
            ))}
          </div>
        )}

        {error && <p className="spawn-error">{error}</p>}

        <div className="spawn-actions">
          <button className="cancel-btn" onClick={onClose}>{t("spawn.cancel")}</button>
          <button
            className="spawn-btn"
            onClick={handleSpawn}
            disabled={!cwd.trim() || loading}
          >
            {loading ? t("spawn.launching") : t("spawn.launch")}
          </button>
        </div>
      </div>
    </div>
  );
}

function shortName(cwd: string) {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}
