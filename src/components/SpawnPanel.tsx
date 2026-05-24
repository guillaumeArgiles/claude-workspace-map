import { useState } from "react";

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
      if (!res.ok) throw new Error(await res.text());
      const { ptyId } = (await res.json()) as { ptyId: string };
      onSpawned({ ptyId, cwd: cwd.trim(), spawnedAt: Date.now() });
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div id="spawn-panel-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div id="spawn-panel">
        <header>
          <h3>New Claude session</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </header>

        <label>Working directory</label>
        <input
          type="text"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSpawn()}
          placeholder="/path/to/project"
          autoFocus
          spellCheck={false}
        />

        {recentCwds.length > 0 && (
          <div className="recent-list">
            <span className="recent-label">Recent</span>
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
          <button className="cancel-btn" onClick={onClose}>Cancel</button>
          <button
            className="spawn-btn"
            onClick={handleSpawn}
            disabled={!cwd.trim() || loading}
          >
            {loading ? "Launching…" : "⚡ Launch Claude"}
          </button>
        </div>
      </div>
    </div>
  );
}

function shortName(cwd: string) {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}
