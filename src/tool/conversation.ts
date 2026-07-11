import { tool } from 'ai'
import { z } from 'zod'

import type { WorkspaceToolFactory } from '../core/workspace-tool-center.js'
import type { HeadlessMessageBlock } from '../workspaces/headless-output.js'

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 1_800_000
const MAX_PROMPT_CHARS = 16_000

export const conversationAskFactory: WorkspaceToolFactory = {
  name: 'conversation_ask',
  build(ctx) {
    return tool({
      description: [
        'Ask a known product Session, an Issue owner, or a fresh worker in one Workspace.',
        '',
        'Use exactly one addressing form: resumeId for an exact Session; issueId (optionally',
        'scoped by wsId) for Issue provenance; or wsId alone to recruit a fresh worker.',
        'The CLI exposes these as --resume-id, --issue-id, and --ws-id. It never requires',
        'callers to construct an internal target object.',
        '',
        'The call is asynchronous and returns a short taskId. Poll with conversation_read.',
      ].join('\n'),
      inputSchema: z.object({
        prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS)
          .describe('Question for the responsible Session or reconstructing worker.'),
        resumeId: z.string().min(1).optional()
          .describe('Exact product Session to continue. Cannot be combined with wsId or issueId.'),
        wsId: z.string().min(1).optional()
          .describe('Workspace for a fresh worker, or optional scope for issueId.'),
        issueId: z.string().min(1).optional()
          .describe('Issue whose attributable Session should answer. Defaults to the current Workspace.'),
        agent: z.string().min(1).optional()
          .describe('Optional runtime for reconstructed/fresh work only; exact Session runtime cannot be overridden.'),
        timeoutMs: z.coerce.number().int().positive().max(MAX_TIMEOUT_MS).optional()
          .describe(`Headless watchdog in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`),
      }),
      execute: async ({ prompt, resumeId, wsId, issueId, agent, timeoutMs }) => {
        if (!ctx.conversation) {
          return { ok: false as const, error: 'workspace conversation control is unavailable' }
        }
        if (resumeId && (wsId || issueId)) {
          return {
            ok: false as const,
            error: 'choose one target: --resume-id, --issue-id [--ws-id], or --ws-id',
          }
        }
        if (!resumeId && !issueId && !wsId) {
          return {
            ok: false as const,
            error: 'provide --resume-id, --issue-id [--ws-id], or --ws-id',
          }
        }
        const target = resumeId
          ? { kind: 'resume' as const, resumeId }
          : issueId
            ? { kind: 'issue' as const, workspaceId: wsId ?? ctx.workspaceId, issueId }
            : { kind: 'workspace' as const, workspaceId: wsId! }
        try {
          const result = await ctx.conversation.ask({
            prompt,
            target,
            timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
            ...(agent ? { agent } : {}),
          })
          if (result.status === 'unavailable') {
            return {
              ok: false as const,
              status: result.status,
              resolution: { mode: result.resolution.mode, reason: result.resolution.reason },
            }
          }
          return {
            ok: true as const,
            status: 'running' as const,
            taskId: result.taskId,
            resumeId: result.resumeId,
            workspaceId: result.workspaceId,
            workspace: result.workspace,
            agent: result.agent,
            resolution: result.resolution.mode === 'reconstructed'
              ? { mode: result.resolution.mode, reason: result.resolution.reason }
              : { mode: result.resolution.mode },
          }
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })
  },
}

export const conversationReadFactory: WorkspaceToolFactory = {
  name: 'conversation_read',
  build(ctx) {
    return tool({
      description: [
        'Read one headless follow-up started by conversation_ask.',
        '',
        'Summary returns the latest assistant reply and one compact failure when present.',
        'Tool activity and normalized message blocks are available only in detailed mode.',
        'Running tasks may have partial output.',
      ].join('\n'),
      inputSchema: z.object({
        taskId: z.string().min(1).describe('taskId returned by conversation_ask.'),
        mode: z.enum(['summary', 'detailed']).optional().default('summary'),
      }),
      execute: async ({ taskId, mode }) => {
        if (!ctx.conversation) {
          return { ok: false as const, error: 'workspace conversation control is unavailable' }
        }
        try {
          const task = await ctx.conversation.read(taskId)
          if (!task) return { ok: false as const, error: `conversation task not found: ${taskId}` }
          const structured = task.structured
          const tools = structured?.blocks
            .filter((block): block is Extract<HeadlessMessageBlock, { type: 'tool' }> => block.type === 'tool')
            .map((block) => ({ name: block.name, status: block.status })) ?? []
          const errors = structured?.blocks
            .filter((block): block is Extract<HeadlessMessageBlock, { type: 'error' }> => block.type === 'error')
            .map((block) => block.message) ?? []
          const compactError = task.error ?? errors.at(-1)
          return {
            ok: true as const,
            taskId: task.taskId,
            resumeId: task.resumeId,
            workspaceId: task.workspaceId,
            agent: task.agent,
            status: task.status,
            assistantText: structured?.assistantText ?? null,
            ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
            ...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
            ...(compactError ? { error: compactError } : {}),
            ...(mode === 'detailed' ? {
              tools,
              errors,
              blocks: structured?.blocks ?? [],
            } : {}),
          }
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })
  },
}

export const conversationToolFactories: WorkspaceToolFactory[] = [
  conversationAskFactory,
  conversationReadFactory,
]
