import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ChevronDown } from 'lucide-react';

import { getGitLog, getGitStatus, type GitLogEntry, type GitStatus } from './api';

const POLL_MS = 3000;
const LOG_LIMIT = 30;

interface GitPanelProps {
  readonly wsId: string;
}

export function GitPanel(props: GitPanelProps): ReactElement {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let alive = true;
    setStatus(null);
    setEntries([]);
    setError(null);

    const refresh = async (): Promise<void> => {
      try {
        const [s, l] = await Promise.all([
          getGitStatus(props.wsId),
          getGitLog(props.wsId, LOG_LIMIT),
        ]);
        if (!alive) return;
        setStatus(s);
        setEntries(l);
        setError(null);
      } catch (err) {
        if (!alive) return;
        setError((err as Error).message);
      }
    };

    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [props.wsId]);

  return (
    <section className={`panel git-panel${collapsed ? ' is-collapsed' : ''}`}>
      <header className="panel-header">
        <button
          type="button"
          className="panel-collapse"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? 'Expand git panel' : 'Collapse git panel'}
          aria-expanded={!collapsed}
        >
          <ChevronDown
            size={11}
            strokeWidth={2.25}
            className={`panel-collapse-chev${collapsed ? ' is-collapsed' : ''}`}
            aria-hidden
          />
        </button>
        <span className="panel-title">git</span>
        {status?.branch && <span className="panel-pill">{status.branch}</span>}
        {status?.clean === false && <span className="panel-pill panel-pill-dirty">{status.files.length} changed</span>}
      </header>

      {!collapsed && (
        <>
          {error && <div className="panel-error">{error}</div>}

          {status && status.files.length > 0 && (
            <ul className="git-status-list">
              {status.files.map((f) => (
                <li key={f.path} className="git-status-row">
                  <GitStatusBadge code={f.status} />
                  <span className="git-status-path">{f.path}</span>
                </li>
              ))}
            </ul>
          )}

          <ul className="git-log-list">
            {entries.length === 0 && !error && (
              <li className="panel-empty">no commits yet</li>
            )}
            {entries.map((e) => (
              <li key={e.hash} className="git-log-row" title={e.authorTime}>
                <span className="git-log-hash">{e.hash}</span>
                <span className="git-log-time">{e.relTime}</span>
                <span className="git-log-subject">{e.subject}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type StatusTone = 'untracked' | 'modified' | 'staged' | 'deleted' | 'renamed' | 'conflict' | 'ignored' | 'unknown';

interface StatusDecoded {
  readonly label: string;
  readonly tone: StatusTone;
}

/**
 * Translate a 2-char git porcelain v1 code into a human label + tone.
 *
 * Porcelain XY: X = index (staged) state, Y = working tree state.
 * Precedence here: conflict > untracked/ignored > deleted > renamed >
 * staged > modified. That order matches what's actionable to a user
 * looking at the panel — a `??` row means "this is new, decide whether
 * to track it"; an `MM` row means "you staged a version but have unstaged
 * changes on top," surfaced as "modified" to keep the label terse (hover
 * the original code in the tooltip for the precise state).
 */
function decodeStatus(code: string): StatusDecoded {
  const X = code[0] ?? ' ';
  const Y = code[1] ?? ' ';

  // Merge / unmerged conflicts: any of DD, AU, UD, UA, DU, AA, UU
  if (X === 'U' || Y === 'U' || (X === 'A' && Y === 'A') || (X === 'D' && Y === 'D')) {
    return { label: 'conflict', tone: 'conflict' };
  }
  if (X === '?' && Y === '?') return { label: 'untracked', tone: 'untracked' };
  if (X === '!' && Y === '!') return { label: 'ignored', tone: 'ignored' };
  if (Y === 'D' || X === 'D') return { label: 'deleted', tone: 'deleted' };
  if (X === 'R' || Y === 'R') return { label: 'renamed', tone: 'renamed' };
  if (X === 'C' || Y === 'C') return { label: 'copied', tone: 'staged' };
  // Index has any change but no working-tree delta → fully staged
  if (X !== ' ' && Y === ' ') return { label: 'staged', tone: 'staged' };
  // Working tree has changes (with or without prior staging)
  if (Y === 'M' || X === 'M') return { label: 'modified', tone: 'modified' };
  if (X === 'A') return { label: 'added', tone: 'staged' };

  return { label: code.trim() || '·', tone: 'unknown' };
}

function GitStatusBadge({ code }: { code: string }): ReactElement {
  const { label, tone } = decodeStatus(code);
  return (
    <span
      className={`git-status-badge is-${tone}`}
      title={`porcelain: ${code.replace(/ /g, '·')}`}
    >
      {label}
    </span>
  );
}
