import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTranslation } from "../i18n";

/** Measure a container's pixel size live. Sidesteps a recharts v3 issue where
 *  ResponsiveContainer renders to 0×0 inside CSS grid items. */
function useElementSize(): [
  React.RefObject<HTMLDivElement>,
  { width: number; height: number },
] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const cr = entry.contentRect;
      setSize({ width: Math.floor(cr.width), height: Math.floor(cr.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

interface TokensByModelEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface StatsResponse {
  range: { from: number; to: number };
  projects: string[];
  totals: {
    sessions: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    tokensByModel: Record<string, TokensByModelEntry>;
    toolCalls: number;
    plansProposed: number;
    plansAccepted: number;
  };
  topTools: Array<{ name: string; count: number }>;
  topProjects: Array<{ cwd: string; sessions: number; tokens: number }>;
  sessionsPerDay: Array<{ date: string; sessions: number }>;
}

type Range = "7d" | "30d" | "all";

interface StatsDashboardProps {
  onClose: () => void;
}

const PIE_COLORS = ["#6366f1", "#22c55e", "#ef4444", "#f59e0b", "#06b6d4", "#a855f7", "#ec4899", "#84cc16", "#14b8a6", "#f97316"];

function shortName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

function rangeToMs(r: Range): { from?: number; to: number } {
  const to = Date.now();
  if (r === "7d") return { from: to - 7 * 24 * 60 * 60 * 1000, to };
  if (r === "30d") return { from: to - 30 * 24 * 60 * 60 * 1000, to };
  // "all" — let the server treat undefined `from` as "since the beginning"
  // by passing a very old date that predates any conceivable JSONL.
  return { from: Date.parse("2020-01-01"), to };
}

export function StatsDashboard({ onClose }: StatsDashboardProps) {
  const { t, locale, plural, formatCompact } = useTranslation();
  const [range, setRange] = useState<Range>("30d");
  const [projectCwd, setProjectCwd] = useState<string>("");
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const { from, to } = rangeToMs(range);
    const params = new URLSearchParams();
    if (from !== undefined) params.set("from", new Date(from).toISOString());
    params.set("to", new Date(to).toISOString());
    if (projectCwd) params.set("projectCwd", projectCwd);
    fetch(`/api/stats?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<StatsResponse>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [range, projectCwd]);

  const acceptRate = useMemo(() => {
    if (!data || data.totals.plansProposed === 0) return null;
    return Math.round((data.totals.plansAccepted / data.totals.plansProposed) * 100);
  }, [data]);

  const totalTokens = data
    ? data.totals.inputTokens + data.totals.outputTokens
      + data.totals.cacheReadTokens + data.totals.cacheCreationTokens
    : 0;

  const topToolsForChart = useMemo(
    () => data?.topTools.slice(0, 8).map((t) => ({ ...t, name: t.name.replace(/^mcp__/, "") })) ?? [],
    [data],
  );

  const topProjectsForChart = useMemo(
    () => data?.topProjects.slice(0, 8).map((p) => ({ name: shortName(p.cwd), value: p.sessions })) ?? [],
    [data],
  );

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  const [lineRef, lineSize] = useElementSize();
  const [barRef, barSize] = useElementSize();
  const [pieRef, pieSize] = useElementSize();

  return (
    <div id="stats-dashboard-backdrop" onClick={handleBackdrop}>
      <div id="stats-dashboard">
        <header>
          <h3>{t("stats.title")}</h3>
          <div className="stats-controls">
            <div className="stats-range">
              {(["7d", "30d", "all"] as Range[]).map((r) => (
                <button
                  key={r}
                  className={`range-btn ${range === r ? "active" : ""}`}
                  onClick={() => setRange(r)}
                >
                  {t(`stats.range.${r}`)}
                </button>
              ))}
            </div>
            <select
              className="stats-project-select"
              value={projectCwd}
              onChange={(e) => setProjectCwd(e.target.value)}
            >
              <option value="">{t("stats.all_projects")}</option>
              {data?.projects.map((p) => (
                <option key={p} value={p}>{shortName(p)}</option>
              ))}
            </select>
            <button className="stats-close-btn" onClick={onClose} aria-label={t("stats.close")}>✕</button>
          </div>
        </header>

        {error && <div className="stats-error">{t("stats.error", { error })}</div>}

        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="label">{t("stats.kpi.sessions")}</div>
            <div className="value">{data ? formatCompact(data.totals.sessions) : "—"}</div>
          </div>
          <div className="kpi-card">
            <div className="label">{t("stats.kpi.tokens")}</div>
            <div className="value">{data ? formatCompact(totalTokens) : "—"}</div>
            {data && (
              <div className="kpi-sub">
                {t("stats.kpi.tokens.sub", {
                  in: formatCompact(data.totals.inputTokens),
                  out: formatCompact(data.totals.outputTokens),
                })}
              </div>
            )}
          </div>
          <div className="kpi-card">
            <div className="label">{t("stats.kpi.toolcalls")}</div>
            <div className="value">{data ? formatCompact(data.totals.toolCalls) : "—"}</div>
          </div>
          <div className="kpi-card">
            <div className="label">{t("stats.kpi.plans")}</div>
            <div className="value">
              {data ? (acceptRate === null ? "—" : `${acceptRate}%`) : "—"}
            </div>
            {data && data.totals.plansProposed > 0 && (
              <div className="kpi-sub">
                {t("stats.kpi.plans.sub", {
                  accepted: data.totals.plansAccepted,
                  proposed: data.totals.plansProposed,
                })}
              </div>
            )}
          </div>
        </div>

        <div className="chart-card stats-chart-wide">
          <div className="chart-title">{t("stats.chart.per_day")}</div>
          <div className="chart-body" ref={lineRef}>
            {lineSize.width > 0 && (
              <LineChart width={lineSize.width} height={lineSize.height} data={data?.sessionsPerDay ?? []} margin={{ top: 8, right: 16, bottom: 4, left: -16 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={11} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis stroke="var(--text-muted)" fontSize={11} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 4 }}
                  labelStyle={{ color: "var(--text-primary)" }}
                />
                <Line type="monotone" dataKey="sessions" stroke="#6366f1" strokeWidth={2} dot={false} />
              </LineChart>
            )}
          </div>
        </div>

        <div className="chart-row">
          <div className="chart-card">
            <div className="chart-title">{t("stats.chart.top_tools")}</div>
            <div className="chart-body" ref={barRef}>
              {barSize.width > 0 && (
                <BarChart width={barSize.width} height={barSize.height} data={topToolsForChart} margin={{ top: 8, right: 16, bottom: 4, left: -16 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={10} interval={0} angle={-25} textAnchor="end" height={60} />
                  <YAxis stroke="var(--text-muted)" fontSize={11} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 4 }}
                    labelStyle={{ color: "var(--text-primary)" }}
                  />
                  <Bar dataKey="count" fill="#22c55e" />
                </BarChart>
              )}
            </div>
          </div>

          <div className="chart-card">
            <div className="chart-title">{t("stats.chart.top_projects")}</div>
            <div className="chart-body" ref={pieRef}>
              {pieSize.width > 0 && (
                <PieChart width={pieSize.width} height={pieSize.height}>
                  <Pie data={topProjectsForChart} dataKey="value" nameKey="name" outerRadius={Math.min(pieSize.width, pieSize.height) / 3} label={(e) => String(e.name ?? "")}>
                    {topProjectsForChart.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 4 }}
                  />
                </PieChart>
              )}
            </div>
          </div>
        </div>

        <footer className="stats-footer">
          <span className="stats-range-text">
            {data
              ? t("stats.footer.summary", {
                  from: new Date(data.range.from).toLocaleDateString(locale),
                  to: new Date(data.range.to).toLocaleDateString(locale),
                  sessions: plural(data.totals.sessions, "stats.plural.sessions"),
                  projects: plural(data.projects.length, "stats.plural.projects"),
                })
              : loading
                ? t("stats.loading")
                : ""}
          </span>
        </footer>
      </div>
    </div>
  );
}
