import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  Building2,
  ChevronRight,
  ClipboardCheck,
  GitMerge,
  KeyRound,
  Loader2,
  Network,
  RefreshCw,
  UsersRound,
  type LucideIcon,
} from 'lucide-react'

import { preferencesApi } from '../api/preferences'
import type { QuickChatPreferences } from '../api/preferences'
import {
  getWorkspaceManager,
  listAgentCredentials,
  MANAGER_WORKSPACE_ID,
  openWebPiSession,
  quickStartWorkspaceManager,
  type ManagerWorkspaceSnapshot,
  type SavedCredential,
} from '../components/workspace/api'
import { WebPiView } from '../components/workspace/WebPiView'
import { useWorkspace } from '../tabs/store'
import type { ViewSpec } from '../tabs/types'

type ManagerSpec = Extract<ViewSpec, { kind: 'workspace-manager' }>

const SUGGESTION_ICONS = [ClipboardCheck, UsersRound, GitMerge, RefreshCw] as const

export function WorkspaceManagerPage({ spec }: { spec: ManagerSpec }) {
  const { t } = useTranslation()
  const openOrFocus = useWorkspace((state) => state.openOrFocus)
  const [manager, setManager] = useState<ManagerWorkspaceSnapshot | null>(null)
  const [credentials, setCredentials] = useState<SavedCredential[] | null>(null)
  const [credentialSlug, setCredentialSlug] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openingRef = useRef<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setManager(await getWorkspaceManager())
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workspaceManager.loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
    void Promise.all([
      listAgentCredentials('pi').catch(() => []),
      preferencesApi.getQuickChat().catch((): QuickChatPreferences => ({ lastCredentialByAgent: {}, recentChatWorkspaceId: null })),
    ]).then(([available, preferences]) => {
      setCredentials(available)
      const remembered = preferences.lastCredentialByAgent.pi
      setCredentialSlug(
        remembered && available.some((credential) => credential.slug === remembered)
          ? remembered
          : available[0]?.slug ?? null,
      )
    })
  }, [refresh])

  const sessionId = spec.params.sessionId
  const session = sessionId
    ? manager?.sessions.find((candidate) => candidate.id === sessionId) ?? null
    : null

  // A manager conversation is always a WebPi conversation. After a backend
  // restart its durable record is paused; opening the URL resumes that exact
  // Pi session with the manager system contract re-applied.
  useEffect(() => {
    if (!sessionId || !session || openingRef.current === sessionId) return
    if (session.state === 'running' && session.surface === 'webpi') return
    openingRef.current = sessionId
    void openWebPiSession(MANAGER_WORKSPACE_ID, sessionId)
      .then(() => refresh())
      .catch((cause) => setError(cause instanceof Error ? cause.message : t('workspaceManager.resumeError')))
      .finally(() => { openingRef.current = null })
  }, [refresh, session, sessionId, t])

  const suggestions = useMemo(() => [
    t('workspaceManager.suggestionAudit'),
    t('workspaceManager.suggestionOwnership'),
    t('workspaceManager.suggestionIssues'),
    t('workspaceManager.suggestionUpgrade'),
  ], [t])

  const submit = async (): Promise<void> => {
    const prompt = draft.trim()
    if (!prompt || launching) return
    if (credentials?.length && !credentialSlug) return
    setLaunching(true)
    setError(null)
    try {
      const result = await quickStartWorkspaceManager(prompt, credentialSlug ?? undefined)
      setManager(result.manager)
      setDraft('')
      openOrFocus({ kind: 'workspace-manager', params: { sessionId: result.session.id } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('workspaceManager.launchError'))
    } finally {
      setLaunching(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  if (sessionId && session) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-bg">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-secondary/35 px-3 py-2 md:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <button
              type="button"
              onClick={() => openOrFocus({ kind: 'workspace-manager', params: {} })}
              className="oa-icon-action rounded-md p-1.5 text-text-muted hover:bg-bg-tertiary hover:text-text"
              title={t('workspaceManager.back')}
              aria-label={t('workspaceManager.back')}
            >
              <ArrowLeft size={15} />
            </button>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
              <Network size={15} />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[12px] font-semibold text-text">{t('workspaceManager.title')}</div>
              <div className="truncate text-[10px] text-text-muted">{session.title ?? session.name}</div>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-bg px-2 py-1 text-[10px] font-medium text-text-muted">
            <Bot size={11} /> Pi · WebPi
          </span>
        </header>
        <div className="min-h-0 flex-1 p-2 md:p-3">
          <WebPiView
            wsId={MANAGER_WORKSPACE_ID}
            sessionId={sessionId}
            label={t('workspaceManager.title')}
            onSessionLost={() => void refresh()}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-y-auto bg-bg">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-accent/[0.07] to-transparent" />
        <div className="absolute -right-24 top-12 h-72 w-72 rounded-full border border-accent/10" />
        <div className="absolute -right-8 top-28 h-44 w-44 rounded-full border border-accent/10" />
      </div>

      <div className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 py-6 md:px-8 md:py-10">
        <div className="mb-7 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/[0.07] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-accent">
              <Network size={12} /> {t('workspaceManager.eyebrow')}
            </div>
            <h1 className="text-2xl font-semibold leading-tight text-text md:text-4xl">
              {t('workspaceManager.heading')}
            </h1>
            <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-text-muted md:text-[15px]">
              {t('workspaceManager.subheading')}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 md:w-72">
            <ManagerStat icon={Building2} label={t('workspaceManager.scope')} value={loading ? '—' : String(manager?.activeWorkspaceCount ?? 0)} />
            <ManagerStat icon={Bot} label={t('workspaceManager.runtime')} value="Pi · WebPi" />
          </div>
        </div>

        <section className="rounded-2xl border border-border/80 bg-bg-secondary/60 p-3 shadow-[0_24px_70px_-58px_var(--color-text)] md:p-4">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('workspaceManager.placeholder')}
            rows={4}
            className="min-h-28 w-full resize-none bg-transparent px-1 py-1 text-[14px] leading-relaxed text-text outline-none placeholder:text-text-muted/55 md:text-[15px]"
          />
          <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-bg-tertiary px-2.5 py-1.5 text-[11px] text-text-muted">
                <Bot size={12} /> Pi · WebPi
              </span>
              {credentials && credentials.length > 0 ? (
                <label className="relative inline-flex min-w-0 items-center gap-1.5 rounded-md bg-bg-tertiary px-2.5 py-1.5 text-[11px] text-text-muted">
                  <KeyRound size={12} className="shrink-0" />
                  <select
                    aria-label={t('workspaceManager.credential')}
                    value={credentialSlug ?? ''}
                    onChange={(event) => {
                      const next = event.target.value || null
                      setCredentialSlug(next)
                      void preferencesApi.rememberQuickChatCredential('pi', next).catch(() => undefined)
                    }}
                    className="max-w-44 appearance-none truncate bg-transparent pr-3 text-text outline-none"
                  >
                    {credentials.map((credential) => (
                      <option key={credential.slug} value={credential.slug}>
                        {credential.label?.trim() || credential.slug}
                      </option>
                    ))}
                  </select>
                </label>
              ) : credentials ? (
                <button
                  type="button"
                  onClick={() => openOrFocus({ kind: 'settings', params: { category: 'ai-provider' } })}
                  className="oa-pressable inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400"
                >
                  <KeyRound size={12} /> {t('workspaceManager.configureCredential')}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!draft.trim() || launching || credentials === null || (credentials.length > 0 && !credentialSlug)}
              className="oa-pressable inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
            >
              {launching ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={14} />}
              {launching ? t('workspaceManager.launching') : t('workspaceManager.send')}
            </button>
          </div>
        </section>

        {error && (
          <div className="mt-3 rounded-lg border border-red/25 bg-red/10 px-3 py-2 text-[12px] text-red">{error}</div>
        )}

        <div className="mt-7 grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <section>
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted/70">
              {t('workspaceManager.suggestions')}
            </h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {suggestions.map((suggestion, index) => {
                const Icon = SUGGESTION_ICONS[index] ?? Network
                return (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => setDraft(suggestion)}
                    className="oa-pressable group flex items-start gap-3 rounded-xl border border-border/70 bg-bg-secondary/45 p-3 text-left hover:border-accent/30 hover:bg-bg-secondary"
                  >
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-text-muted group-hover:text-accent">
                      <Icon size={14} />
                    </span>
                    <span className="text-[12px] leading-relaxed text-text-muted group-hover:text-text">{suggestion}</span>
                  </button>
                )
              })}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-text-muted/65">{t('workspaceManager.guardrail')}</p>
          </section>

          <section>
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted/70">
              {t('workspaceManager.recent')}
            </h2>
            <div className="overflow-hidden rounded-xl border border-border/70 bg-bg-secondary/35">
              {manager?.sessions.length ? manager.sessions.slice(0, 5).map((record) => (
                <button
                  key={record.id}
                  type="button"
                  onClick={() => openOrFocus({ kind: 'workspace-manager', params: { sessionId: record.id } })}
                  className="oa-pressable flex w-full items-center gap-3 border-b border-border/55 px-3 py-2.5 text-left last:border-b-0 hover:bg-bg-tertiary/65"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${record.state === 'running' ? 'bg-green' : 'bg-text-muted/30'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-text">{record.title ?? record.name}</span>
                    <span className="mt-0.5 block text-[10px] text-text-muted">{new Date(record.lastActiveAt).toLocaleString()}</span>
                  </span>
                  <ChevronRight size={14} className="shrink-0 text-text-muted/50" />
                </button>
              )) : (
                <p className="px-3 py-5 text-center text-[11px] text-text-muted/60">{t('workspaceManager.noRecent')}</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function ManagerStat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-bg-secondary/55 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.11em] text-text-muted/60">
        <Icon size={11} /> {label}
      </div>
      <div className="mt-1.5 truncate text-[13px] font-semibold text-text">{value}</div>
    </div>
  )
}
