import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../lib/intl'
import { ArrowRight, ChevronRight, MessageSquare, Trash2 } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { MarkdownContent } from '../components/MarkdownContent'
import { FileContentView } from '../components/FileContentView'
import { api } from '../api'
import { inboxLive, refreshInbox, removeInboxOptimistically } from '../live/inbox'
import { useInboxSelection } from '../live/inbox-selection'
import { useInboxRead } from '../live/inbox-read'
import { useWorkspace } from '../tabs/store'
import { useWorkspaces } from '../contexts/WorkspacesContext'
import { readWorkspaceFile, type ReadFileResult } from '../components/workspace/api'
import type { InboxEntry, InboxDoc } from '../api/inbox'

interface InboxPageProps {
  /** Gates the page-level Delete/Backspace shortcut so background
   *  inbox tabs don't intercept the keypress. */
  visible: boolean
}

/**
 * Inbox detail pane. Renders the entry's docs (live from workspace) on
 * top as collapsed attachment cards, then the agent's comment (markdown
 * body) below. Docs-on-top is deliberate: collapsed they're compact (a
 * filename + 2-line preview), so they can't flood the pane the way a
 * full auto-rendered file would — and putting them above the comment
 * means a long comment can't push them off-screen and get them missed.
 * Each card shows a short text preview so it reads as openable content,
 * not a bare filename; content is fetched on mount (preview) and the
 * same content renders in full on expand. A comment-less entry (docs
 * ARE the message) defaults its docs expanded.
 *
 * Selection is owned by `useInboxSelection`; the sidebar drives it.
 * Read-state mutation happens in the sidebar at selection time — this
 * pane just renders whatever is selected. Delete is owned here (both
 * the button in the Detail header and the Delete/Backspace shortcut)
 * because it needs access to the full entry list to advance selection
 * to the next entry after removal.
 */
export function InboxPage({ visible }: InboxPageProps) {
  const { t } = useTranslation()
  const entries = inboxLive.useStore((s) => s.entries)
  const loading = inboxLive.useStore((s) => s.loading)
  const selectedId = useInboxSelection((s) => s.selectedEntryId)
  const select = useInboxSelection((s) => s.select)
  const markRead = useInboxRead((s) => s.markRead)

  const selected = entries.find((e) => e.id === selectedId) ?? null

  /** Hard-delete an entry. Optimistically removes from local state,
   *  advances selection to the next-older entry (or previous if last),
   *  fires the DELETE request, then forces a refresh to reconcile with
   *  the server. Match Linear's "archive removes from view, focus
   *  advances" feel — no confirmation dialog. */
  const handleDelete = useCallback(async (id: string) => {
    const idx = entries.findIndex((e) => e.id === id)
    if (idx < 0) return

    // entries is sorted newest-first; "the one after this" is the next
    // older entry. Fall back to the previous (newer) if we deleted the
    // tail; null if the list becomes empty.
    const nextId = entries[idx + 1]?.id ?? entries[idx - 1]?.id ?? null

    removeInboxOptimistically(id)
    if (nextId) {
      select(nextId)
      markRead(nextId)
    } else {
      select(null)
    }

    try {
      await api.inbox.delete(id)
    } catch {
      // best-effort — refreshInbox below will reconcile if the server
      // disagreed (e.g. concurrent change re-introduced the entry).
    }
    refreshInbox()
  }, [entries, select, markRead])

  // Delete / Backspace shortcut. Gated on `visible` so a background
  // inbox tab doesn't intercept; gated on `selectedId` so the
  // keypress only fires when there's something to delete.
  useEffect(() => {
    if (!visible) return
    if (!selectedId) return
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      e.preventDefault()
      // selectedId is captured by the closure; safe to use.
      void handleDelete(selectedId!)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, selectedId, handleDelete])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader
        title={t('nav.item.inbox')}
        description={t('inbox.pageDescription', { count: entries.length })}
      />
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && entries.length === 0 ? (
          <div className="px-6 py-8 text-text-muted text-sm">{t('common.loading')}</div>
        ) : entries.length === 0 ? (
          <EmptyState />
        ) : !selected ? (
          <div className="px-6 py-8 text-text-muted text-sm">
            {t('inbox.selectFromSidebar')}
          </div>
        ) : (
          <Detail entry={selected} onDelete={() => handleDelete(selected.id)} />
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="px-6 py-16 text-center max-w-[520px] mx-auto">
      <div className="text-[15px] text-text mb-2">{t('inbox.noMessages')}</div>
      <p className="text-[13px] text-text-muted leading-relaxed">
        Workspaces push updates here as they work — finished analysis,
        blocked tasks, questions back to you. An agent surfaces one by
        calling the
        <code className="mx-1 px-1 py-0.5 rounded bg-bg-tertiary text-[11px]">inbox_push</code>
        tool from inside its workspace. Nothing to read yet.
      </p>
    </div>
  )
}

function Detail({ entry, onDelete }: { entry: InboxEntry; onDelete: () => void }) {
  const { t } = useTranslation()
  const hasDocs = (entry.docs?.length ?? 0) > 0
  const hasComments = (entry.comments ?? '').trim().length > 0

  // Workspace liveness — drives whether the jump-to-workspace affordance
  // is enabled. A deleted workspace's inbox entry stays as a record but
  // has nowhere to navigate to.
  const { workspaces } = useWorkspaces()
  const aliveWorkspace = workspaces.find((w) => w.id === entry.workspaceId) ?? null
  const wsAlive = aliveWorkspace !== null
  const displayLabel = aliveWorkspace?.tag ?? entry.workspaceLabel ?? entry.workspaceId

  const openOrFocus = useWorkspace((s) => s.openOrFocus)
  const setSidebar = useWorkspace((s) => s.setSidebar)

  const openWorkspace = () => {
    if (!wsAlive) return
    // Switch the sidebar to Workspaces so the user sees the sessions list
    // alongside the workspace tab (analogue to "open the issue then IM in
    // chat" — they need both views).
    setSidebar('workspaces')
    openOrFocus({ kind: 'workspace', params: { wsId: entry.workspaceId } })
  }

  return (
    <div className="max-w-[820px] mx-auto py-6 px-4 md:px-8">
      {/* Header: workspace · timestamp · delete. Plain text label —
       *  the primary navigation affordance sits at the bottom of the
       *  comments thread (Linear-style reply input). Trash button is
       *  always visible, muted by default with accent-red on hover —
       *  Linear's archive affordance equivalent. Hard delete (no undo
       *  modal); keyboard parity via Delete / Backspace at the page
       *  level. */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span
          className={`text-[14px] font-medium ${
            wsAlive ? 'text-text' : 'text-text-muted/70 line-through'
          }`}
          title={wsAlive ? undefined : t('inbox.workspaceNotExists')}
        >
          {displayLabel}
        </span>
        <span className="text-[11px] text-text-muted/70 tabular-nums ml-auto">
          {formatAbsolute(entry.ts)}
          <span className="mx-1.5 text-text-muted/40">·</span>
          {formatRelativeTime(entry.ts)}
        </span>
        <button
          type="button"
          onClick={onDelete}
          className="p-1 rounded text-text-muted/50 hover:text-red hover:bg-red/10 transition-colors"
          title={t('inbox.deleteEntryTitle')}
          aria-label={t('inbox.deleteEntryAriaLabel')}
        >
          <Trash2 size={14} strokeWidth={1.75} />
        </button>
      </div>

      {/* Docs — top, live render from workspace, as collapsed attachment
       *  cards. Above the comment so a long comment can't push them
       *  off-screen; collapsed (filename + preview) so they stay compact.
       *  Expanded by default only when there's no comment (docs ARE the
       *  message then). */}
      {hasDocs && (
        <div>
          <div className="text-[11px] font-medium text-text-muted/60 uppercase tracking-wider mb-3">
            {t('inbox.documentsSection')}
          </div>
          <div className="space-y-3">
            {entry.docs!.map((doc) => (
              <DocBlock
                key={doc.path}
                workspaceId={entry.workspaceId}
                doc={doc}
                defaultExpanded={!hasComments}
              />
            ))}
          </div>
        </div>
      )}

      {/* Comment — below the docs, the agent's voice and the main body.
       *  No section label (it IS the body); a divider separates it from
       *  the docs above when both are present. */}
      {hasComments && (
        <div className={`${hasDocs ? 'mt-6 pt-6 border-t border-border' : ''}`}>
          <MarkdownContent
            text={entry.comments!}
            className="leading-relaxed text-text/90"
          />
        </div>
      )}

      {/* Reply bar — the navigation entry point. Linear-style: a wide bar
       *  appended to the comments thread, visually styled like a chat
       *  input. The action isn't actually sending — clicking opens the
       *  workspace tab + switches the sidebar so the user can pick a
       *  session and chat back to the agent there. v2 could pre-fill the
       *  workspace chat input with whatever the user types here; for v1
       *  the bar is single-click navigation. */}
      <div className="mt-6">
        {wsAlive ? (
          <button
            type="button"
            onClick={openWorkspace}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-bg-tertiary/40 hover:bg-bg-tertiary hover:border-accent/40 transition-colors text-left group"
          >
            <MessageSquare size={15} strokeWidth={1.75} className="shrink-0 text-text-muted/70 group-hover:text-accent transition-colors" />
            <span className="flex-1 text-[13px] text-text-muted/80 group-hover:text-text transition-colors">
              {t('inbox.replyInWorkspace', { label: displayLabel })}
            </span>
            <ArrowRight size={15} strokeWidth={1.75} className="shrink-0 text-text-muted/60 group-hover:text-accent group-hover:translate-x-0.5 transition-all" />
          </button>
        ) : (
          <div className="px-4 py-3 text-[12px] text-text-muted/60 italic border-t border-border/40 pt-4">
            {t('inbox.cannotReplyWorkspaceGone')}
          </div>
        )}
      </div>

      <div className="mt-4 text-[11px] text-text-muted/40 font-mono">
        workspace: {entry.workspaceId}
      </div>
    </div>
  )
}

// ==================== Doc block (live fetch from workspace) ====================

function DocBlock({
  workspaceId, doc, defaultExpanded,
}: {
  workspaceId: string
  doc: InboxDoc
  defaultExpanded: boolean
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [result, setResult] = useState<ReadFileResult | null>(null)

  // Fetch on mount: the collapsed card shows a text preview, so we need the
  // content up front. The same `result` then renders in full on expand —
  // one fetch serves both states.
  useEffect(() => {
    let cancelled = false
    setResult(null)
    readWorkspaceFile(workspaceId, doc.path).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => { cancelled = true }
  }, [workspaceId, doc.path])

  const preview = useMemo(() => buildDocPreview(result), [result])

  const header = (
    <div className="px-4 py-3 flex items-center gap-2.5">
      <ChevronRight
        size={15}
        strokeWidth={2}
        aria-hidden
        className={`shrink-0 text-text-muted/70 transition-transform ${expanded ? 'rotate-90' : ''}`}
      />
      <span className="text-[12px]">📄</span>
      <span className="flex-1 truncate text-[12px] font-mono text-text-muted">{doc.path}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-text-muted/45">
        {expanded ? t('inbox.docCollapse') : t('inbox.docExpand')}
      </span>
    </div>
  )

  return (
    <div className="rounded-lg border border-border bg-bg/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full text-left bg-bg-tertiary/25 hover:bg-bg-tertiary/50 transition-colors"
      >
        {header}
        {/* Collapsed: a short text preview so the card reads as openable
         *  content rather than a bare filename. Hidden once expanded (the
         *  full render takes over below). */}
        {!expanded && (
          <div className="pl-11 pr-4 pb-3 -mt-1.5 text-[12px] leading-relaxed text-text-muted/70 line-clamp-2">
            {result === null ? t('common.loading') : preview || t('inbox.docNoPreview')}
          </div>
        )}
      </button>
      {expanded && (
        <div className="px-4 py-3 border-t border-border/50">
          {result === null ? (
            <div className="text-[12px] text-text-muted">{t('common.loading')}</div>
          ) : (
            <FileContentView path={doc.path} result={result} />
          )}
        </div>
      )}
    </div>
  )
}

/** Build a short plain-text preview from a fetched doc, for the collapsed
 *  card. Takes the first couple of non-empty lines and strips the most
 *  common markdown leaders / inline markers so the snippet reads as prose.
 *  Returns '' for non-ok results (loading / missing / too-large) — the
 *  caller shows its own fallback. */
function buildDocPreview(result: ReadFileResult | null): string {
  if (!result || result.kind !== 'ok') return ''
  const strip = (s: string): string =>
    s
      .replace(/^#{1,6}\s+/, '')        // heading markers
      .replace(/^[>*\-+]\s+/, '')       // quote / list leaders
      .replace(/[*_`]/g, '')            // emphasis / code ticks
      .replace(/\[\[([^[\]]+)\]\]/g, '$1') // wikilinks → text
      .trim()
  const lines = result.content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map(strip)
  // Single flowing snippet (title — first paragraph), clamped to 2 visual
  // lines by the caller. A separator beats a newline here: `-webkit-line-
  // clamp` leaves a faint sliver of a third line when fed hard breaks.
  const joined = lines.join(' — ')
  // ~100 chars keeps CJK-dense snippets within 2 lines, so the caller's
  // `line-clamp-2` rarely has to bite (its cut leaves a faint sliver).
  return joined.length > 100 ? joined.slice(0, 100).trimEnd() + '…' : joined
}

// ==================== Date formatting ====================

function formatAbsolute(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

