import type {
  AgentState,
  PendingQuestion,
  SubAgentState,
} from "../../shared/agent-types";
import {
  studentSpriteFor,
  teacherSpriteFor,
} from "../../shared/agent-sprites";
import { STATUS_COLOR } from "../../shared/agent-ui";
import { useTranslation } from "../i18n";

export interface ActivePty {
  ptyId: string;
  cwd: string;
  minimized: boolean;
}

function spriteStyle(spriteName: string): React.CSSProperties {
  return {
    backgroundImage: `url(/assets/sprites/${spriteName}.png)`,
    backgroundPosition: "-32px 0px",
    backgroundSize: "96px 128px",
    width: 32,
    height: 32,
    imageRendering: "pixelated",
  };
}

// ── AgentRow ────────────────────────────────────────────────────────────────
export function AgentRow({
  agent,
  pty,
  resuming,
  active,
  onClick,
  onDismiss,
}: {
  agent: AgentState;
  pty?: ActivePty;
  resuming: boolean;
  /** Visually highlight the row (used by the palette's keyboard cursor). */
  active?: boolean;
  onClick: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const liveSubs = agent.subAgents.filter((s) => !s.finished);

  let termTitle: string;
  if (resuming)            termTitle = t("agent.row.opening");
  else if (pty?.minimized) termTitle = t("agent.row.restore");
  else if (pty)            termTitle = t("agent.row.terminal_open");
  else                     termTitle = t("agent.row.open_in_cc", { sessionShort: agent.sessionId.slice(0, 8) });

  const hasPending = agent.pendingPlan !== undefined ||
    (agent.pendingQuestions && agent.pendingQuestions.length > 0);

  return (
    <li className={`agent ${active ? "active" : ""}`}>
      <div
        className={`agent-head ${resuming ? "resuming" : ""}`}
        role="button"
        tabIndex={0}
        onClick={resuming ? undefined : onClick}
        onKeyDown={(e) => { if (!resuming && (e.key === "Enter" || e.key === " ")) onClick(); }}
        title={termTitle}
        aria-busy={resuming}
      >
        <span className="icon teacher" style={spriteStyle(teacherSpriteFor(agent.sessionId))} />
        <div className="meta">
          <div className="line">
            <span
              className={`status-dot${agent.status === "awaiting_approval" || agent.status === "blocked" ? " status-dot-pulse" : ""}`}
              style={{ background: STATUS_COLOR[agent.status] }}
            />
            <span className="status">{t(`status.${agent.status}`)}</span>
            {agent.currentTool ? <span className="tool"> · {agent.currentTool}</span> : null}
          </div>
          {agent.currentToolDetail ? (
            <div className="detail" title={agent.currentToolDetail}>{agent.currentToolDetail}</div>
          ) : null}
        </div>
        {resuming ? (
          <span className="terminal-badge resuming-badge" title={t("agent.row.launching")}>···</span>
        ) : pty ? (
          <span
            className={`terminal-badge ${pty.minimized ? "minimized" : "active"}`}
            title={pty.minimized ? t("agent.row.terminal_minimized") : t("agent.row.terminal_open_title")}
          >
            &gt;_
          </span>
        ) : (
          <span className="terminal-badge resume-hint" title={termTitle}>▶</span>
        )}
        <button
          className="dismiss-btn"
          title={t("agent.row.dismiss")}
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        >
          ×
        </button>
      </div>

      {hasPending && (
        <PendingApprovalWidget agent={agent} pty={pty} onOpenTerminal={onClick} />
      )}

      {liveSubs.length > 0 && (
        <ul className="subs">
          {liveSubs.map((s) => <SubAgentRow key={s.id} sub={s} />)}
        </ul>
      )}
    </li>
  );
}

// ── PendingApprovalWidget ────────────────────────────────────────────────────
/**
 * Inline card rendered below an agent row when Claude is waiting for the
 * user's input (ExitPlanMode → plan, AskUserQuestion → questions).
 */
function PendingApprovalWidget({
  agent,
  pty,
  onOpenTerminal,
}: {
  agent: AgentState;
  pty?: ActivePty;
  onOpenTerminal: () => void;
}) {
  const canInteract = !!pty;

  if (agent.pendingPlan) {
    return <PlanWidget plan={agent.pendingPlan} canInteract={canInteract} onOpen={onOpenTerminal} />;
  }
  if (agent.pendingQuestions && agent.pendingQuestions.length > 0) {
    return <QuestionsWidget questions={agent.pendingQuestions} canInteract={canInteract} onOpen={onOpenTerminal} />;
  }
  return null;
}

function PlanWidget({ plan, canInteract, onOpen }: { plan: string; canInteract: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const lines = plan.split("\n").filter((l) => l.trim());
  const title = (lines[0] ?? t("agent.approval.plan_fallback_title")).replace(/^#+\s*/, "");
  const bodyLines = lines.slice(1).filter((l) => !l.startsWith("#")).slice(0, 3);
  const preview = bodyLines.join(" ").slice(0, 140);

  return (
    <div className="approval-widget">
      <div className="approval-header">
        <span className="approval-icon">📋</span>
        <span className="approval-title">{title}</span>
      </div>
      {preview && <p className="approval-preview">{preview}{preview.length >= 140 ? "…" : ""}</p>}
      <div className="approval-actions">
        {canInteract ? (
          <button className="approval-btn" onClick={onOpen}>
            {t("agent.approval.respond")}
          </button>
        ) : (
          <span className="approval-external-hint">
            {t("agent.approval.external_hint")}
          </span>
        )}
      </div>
    </div>
  );
}

function QuestionsWidget({
  questions,
  canInteract,
  onOpen,
}: {
  questions: PendingQuestion[];
  canInteract: boolean;
  onOpen: () => void;
}) {
  const { t, plural } = useTranslation();
  const q = questions[0];
  return (
    <div className="approval-widget">
      <div className="approval-header">
        <span className="approval-icon">❓</span>
        <span className="approval-title">{q.question}</span>
      </div>
      <ul className="approval-options">
        {q.options.map((opt, i) => (
          <li key={i} className="approval-option">
            <span className="option-num">{i + 1}.</span>
            <span className="option-label">{opt.label}</span>
            {opt.description && (
              <span className="option-desc">{opt.description}</span>
            )}
          </li>
        ))}
      </ul>
      {questions.length > 1 && (
        <p className="approval-more">{plural(questions.length - 1, "agent.row.more_questions")}</p>
      )}
      <div className="approval-actions">
        {canInteract ? (
          <button className="approval-btn" onClick={onOpen}>
            {t("agent.approval.respond")}
          </button>
        ) : (
          <span className="approval-external-hint">
            {t("agent.approval.external_hint")}
          </span>
        )}
      </div>
    </div>
  );
}

// ── SubAgentRow ─────────────────────────────────────────────────────────────
export function SubAgentRow({ sub }: { sub: SubAgentState }) {
  const { t } = useTranslation();
  return (
    <li className="sub-agent" tabIndex={0}>
      <span
        className="icon student"
        style={{
          backgroundImage: `url(/assets/sprites/${studentSpriteFor(sub.id)}.png)`,
          backgroundPosition: "-24px 0px",
          backgroundSize: "72px 96px",
          width: 24,
          height: 24,
          imageRendering: "pixelated",
          flex: "0 0 24px",
          backgroundRepeat: "no-repeat",
        }}
      />
      <div className="meta">
        <div className="name" title={sub.description}>{sub.description || t("agent.row.sub_task")}</div>
        <div className="line">
          <span className="status-dot" style={{ background: STATUS_COLOR[sub.status] }} />
          <span className="status">{t(`status.${sub.status}`)}</span>
          {sub.currentTool ? <span className="tool"> · {sub.currentTool}</span> : null}
        </div>
        {sub.currentToolDetail ? (
          <div className="detail" title={sub.currentToolDetail}>{sub.currentToolDetail}</div>
        ) : null}
      </div>
    </li>
  );
}
