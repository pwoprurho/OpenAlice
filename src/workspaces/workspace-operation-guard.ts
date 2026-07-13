export interface WorkspaceOperationLease {
  readonly workspaceId: string;
  readonly operation: string;
  release(): void;
}

/**
 * Serializes directory-wide Workspace mutations inside the Alice process.
 *
 * Template Upgrade, offboarding, and a future Merge/Absorb flow have different
 * domain rules, but none may rename or reconcile the same checkout while
 * another one is in flight. The lease is deliberately synchronous so there is
 * no gap between checking availability and claiming the Workspace.
 */
export class WorkspaceOperationGuard {
  private readonly active = new Map<string, string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  acquire(workspaceId: string, operation: string): WorkspaceOperationLease | null {
    if (this.active.has(workspaceId)) return null;
    this.active.set(workspaceId, operation);
    let released = false;
    return {
      workspaceId,
      operation,
      release: () => {
        if (released) return;
        released = true;
        if (this.active.get(workspaceId) === operation) {
          this.active.delete(workspaceId);
          this.waiters.get(workspaceId)?.shift()?.();
          if (this.waiters.get(workspaceId)?.length === 0) this.waiters.delete(workspaceId);
        }
      },
    };
  }

  /**
   * Read/review operations may queue behind a directory mutation instead of
   * flashing a transient busy error. Mutating callers still use `acquire()`
   * so a duplicate apply/offboard request fails explicitly.
   */
  async acquireWhenAvailable(workspaceId: string, operation: string): Promise<WorkspaceOperationLease> {
    for (;;) {
      const lease = this.acquire(workspaceId, operation);
      if (lease) return lease;
      await new Promise<void>((resolve) => {
        const queue = this.waiters.get(workspaceId) ?? [];
        queue.push(resolve);
        this.waiters.set(workspaceId, queue);
      });
    }
  }

  current(workspaceId: string): string | null {
    return this.active.get(workspaceId) ?? null;
  }
}
