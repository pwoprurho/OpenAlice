import { fetchJson, headers } from './client'

export interface QuickChatPreferences {
  lastCredentialByAgent: Record<string, string>
}

export type WorkspaceShellStatus =
  | { supported: false }
  | {
      supported: true
      mode: 'auto' | 'custom'
      customPath: string | null
      resolvedPath: string | null
      source: 'custom' | 'managed' | 'environment' | 'git-for-windows' | 'none'
      valid: boolean
      message: string | null
    }

export const preferencesApi = {
  getQuickChat(): Promise<QuickChatPreferences> {
    return fetchJson('/api/preferences/quick-chat')
  },

  rememberQuickChatCredential(
    agent: 'opencode' | 'pi',
    credentialSlug: string | null,
  ): Promise<QuickChatPreferences> {
    return fetchJson('/api/preferences/quick-chat', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ agent, credentialSlug }),
    })
  },

  getWorkspaceShell(): Promise<WorkspaceShellStatus> {
    return fetchJson('/api/preferences/workspace-shell')
  },

  saveWorkspaceShell(input: {
    mode: 'auto' | 'custom'
    customPath?: string | null
  }): Promise<WorkspaceShellStatus> {
    return fetchJson('/api/preferences/workspace-shell', {
      method: 'PUT',
      headers,
      body: JSON.stringify(input),
    })
  },
}
