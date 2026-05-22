import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * User preference for which workspace right-pane side panels render.
 *
 * Stored at the user level (not per-workspace) — every workspace has the
 * same Git + Files panels, so a per-workspace toggle would be friction
 * for no payoff.
 *
 * `autoHideMobile` controls whether the entire right column hides at
 * sub-md viewports. Default true: on a phone, the right column eating
 * 360px is a worse experience than not seeing git/files at all. Users
 * can flip it off if they actually want both on a small screen.
 */

interface WorkspaceSidePanelsState {
  git: boolean
  files: boolean
  autoHideMobile: boolean
}

interface WorkspaceSidePanelsActions {
  setPanel: (key: 'git' | 'files', enabled: boolean) => void
  setAutoHideMobile: (enabled: boolean) => void
}

export const useWorkspaceSidePanels = create<WorkspaceSidePanelsState & WorkspaceSidePanelsActions>()(
  persist(
    (set) => ({
      git: true,
      files: true,
      autoHideMobile: true,
      setPanel: (key, enabled) => set({ [key]: enabled } as Pick<WorkspaceSidePanelsState, 'git' | 'files'>),
      setAutoHideMobile: (enabled) => set({ autoHideMobile: enabled }),
    }),
    { name: 'openalice.workspace.side-panels.v1', version: 1 },
  ),
)
