import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { PanelRight } from 'lucide-react'

import { useWorkspaceSidePanels } from '../../live/workspace-side-panels'

/**
 * Top-bar button that opens a small popover for toggling the workspace
 * right-pane side panels. Lives next to "AI Provider" in WorkspacePage's
 * header.
 *
 * Click outside closes the popover. State is user-level (not per-
 * workspace) — see `useWorkspaceSidePanels` for rationale.
 */
export function WorkspaceLayoutPopover(): ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const prefs = useWorkspaceSidePanels()

  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
        title="Show / hide right-pane panels"
        aria-expanded={open}
      >
        <PanelRight size={13} strokeWidth={1.8} aria-hidden />
        Layout
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Workspace layout"
          className="absolute right-0 top-full mt-1 w-[220px] z-50 p-2 rounded-md bg-bg-tertiary border border-border shadow-lg text-[12px] text-text"
        >
          <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-text-muted/60 font-medium">
            Side panels
          </div>
          <CheckboxRow
            label="Git"
            checked={prefs.git}
            onChange={(v) => prefs.setPanel('git', v)}
          />
          <CheckboxRow
            label="Files"
            checked={prefs.files}
            onChange={(v) => prefs.setPanel('files', v)}
          />
          <div className="my-1.5 border-t border-border" />
          <CheckboxRow
            label="Auto-hide on mobile"
            checked={prefs.autoHideMobile}
            onChange={prefs.setAutoHideMobile}
          />
        </div>
      )}
    </div>
  )
}

function CheckboxRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}): ReactElement {
  return (
    <label className="flex items-center gap-2 px-1 py-1 rounded hover:bg-bg-secondary/50 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      <span>{label}</span>
    </label>
  )
}
