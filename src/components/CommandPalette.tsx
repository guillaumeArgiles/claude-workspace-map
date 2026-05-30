import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentState } from "../../shared/agent-types";
import { AgentRow, type ActivePty } from "./AgentRow";
import { useTranslation } from "../i18n";

/**
 * Items the palette renders. Two shapes:
 * - `agent`: full sidebar-style row (sprite, status, sub-agents nested,
 *   pending-approval widget, dismiss × on hover). Search matches on project
 *   name, status, tool, tool detail, sessionId.
 * - `simple` (default): a one-line action with optional icon/hint/detail.
 *   Search matches on label/hint/group.
 */
export type CommandItem = SimpleCommandItem | AgentCommandItem;

export interface SimpleCommandItem {
  kind?: "simple";
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon?: string;
  /** Sprite filename (without extension) under /assets/sprites/. */
  iconSprite?: string;
  /** Colored dot rendered before the hint. */
  statusColor?: string;
  /** Secondary muted line under the label. */
  detail?: string;
  onSelect: () => void;
}

export interface AgentCommandItem {
  kind: "agent";
  id: string;
  group: string;
  agent: AgentState;
  pty?: ActivePty;
  resuming: boolean;
  onSelect: () => void;
  onDismiss: () => void;
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

function matchesQuery(it: CommandItem, q: string): boolean {
  if (it.kind === "agent") {
    const a = it.agent;
    const haystack = [
      a.projectName,
      a.cwd,
      a.status,
      a.currentTool,
      a.currentToolDetail,
      a.sessionId,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  }
  return (
    it.label.toLowerCase().includes(q) ||
    (it.hint?.toLowerCase().includes(q) ?? false) ||
    it.group.toLowerCase().includes(q)
  );
}

interface CommandPaletteProps {
  items: CommandItem[];
  onClose: () => void;
}

export function CommandPalette({ items, onClose }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => matchesQuery(it, q));
  }, [items, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const grouped = useMemo(() => {
    const out: { group: string; items: { it: CommandItem; idx: number }[] }[] = [];
    let current: { group: string; items: { it: CommandItem; idx: number }[] } | null = null;
    filtered.forEach((it, idx) => {
      if (!current || current.group !== it.group) {
        current = { group: it.group, items: [] };
        out.push(current);
      }
      current.items.push({ it, idx });
    });
    return out;
  }, [filtered]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = filtered[activeIdx];
      if (picked) {
        onClose();
        picked.onSelect();
      }
    }
  }

  return (
    <div
      id="cmd-palette-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div id="cmd-palette" onKeyDown={onKey}>
        <input
          ref={inputRef}
          className="cmd-palette-input"
          type="text"
          placeholder={t("palette.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="cmd-palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cmd-palette-empty">{t("palette.empty")}</div>
          ) : (
            grouped.map((g) => {
              const isAgentGroup = g.items.every(({ it }) => it.kind === "agent");
              return (
                <div key={g.group} className="cmd-palette-group">
                  <div className="cmd-palette-group-label">{g.group}</div>
                  {isAgentGroup ? (
                    <ul className="cmd-palette-agents">
                      {g.items.map(({ it, idx }) => {
                        const item = it as AgentCommandItem;
                        return (
                          <div
                            key={item.id}
                            data-idx={idx}
                            className={`cmd-palette-agent-wrap ${idx === activeIdx ? "active" : ""}`}
                            onMouseEnter={() => setActiveIdx(idx)}
                            onClick={() => { onClose(); item.onSelect(); }}
                          >
                            <AgentRow
                              agent={item.agent}
                              pty={item.pty}
                              resuming={item.resuming}
                              active={idx === activeIdx}
                              onClick={() => { onClose(); item.onSelect(); }}
                              onDismiss={item.onDismiss}
                            />
                          </div>
                        );
                      })}
                    </ul>
                  ) : (
                    g.items.map(({ it, idx }) => {
                      const item = it as SimpleCommandItem;
                      return (
                        <div
                          key={item.id}
                          data-idx={idx}
                          className={`cmd-palette-item ${idx === activeIdx ? "active" : ""}`}
                          onMouseEnter={() => setActiveIdx(idx)}
                          onClick={() => { onClose(); item.onSelect(); }}
                        >
                          {item.iconSprite ? (
                            <span className="cmd-palette-icon sprite" style={spriteStyle(item.iconSprite)} />
                          ) : item.icon ? (
                            <span className="cmd-palette-icon">{item.icon}</span>
                          ) : null}
                          <div className="cmd-palette-text">
                            <span className="cmd-palette-label">{item.label}</span>
                            {item.detail && <span className="cmd-palette-detail">{item.detail}</span>}
                          </div>
                          {item.statusColor && (
                            <span
                              className="cmd-palette-status"
                              style={{ background: item.statusColor }}
                            />
                          )}
                          {item.hint && <span className="cmd-palette-hint">{item.hint}</span>}
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })
          )}
        </div>
        <div className="cmd-palette-footer">
          <kbd>↑</kbd><kbd>↓</kbd> {t("palette.footer.navigate")}
          <kbd>↵</kbd> {t("palette.footer.select")}
          <kbd>esc</kbd> {t("palette.footer.close")}
        </div>
      </div>
    </div>
  );
}
