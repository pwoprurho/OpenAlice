/**
 * Capability-described handle on a coding-agent CLI (claude, codex, shell, …).
 *
 * The pool, watcher, and discovery layers consult an adapter to:
 *   1. Translate a spawn intent (`resume`?) into the CLI's native command flags.
 *   2. Decide whether/how to discover on-disk transcripts for this CLI.
 *   3. Provide CLI-specific env strips/sets and one-time bootstrap (writing
 *      config files, registering MCP servers in the CLI's native format, etc.).
 *
 * In v2.M1 only `claude` is registered; the interface exists so v2.M2+ can
 * land codex/shell without touching the core PTY/protocol/UI plumbing.
 */

export interface OnDiskSession {
  readonly sessionId: string;
  readonly file: string;
  readonly mtime: string;
  readonly sizeBytes: number;
}

export interface SpawnContext {
  readonly resume?: 'last' | { readonly sessionId: string };
  /** Workspace cwd; lets adapters read e.g. `<cwd>/.mcp.json`. */
  readonly cwd: string;
  /**
   * Final env the PTY will be spawned with (after `spawn-env.ts`). Adapters
   * use this for `${VAR}` placeholder expansion when translating a
   * cross-CLI MCP definition into their own native command flags.
   */
  readonly env: Readonly<Record<string, string>>;
}

export interface BootstrapContext {
  readonly wsId: string;
  readonly cwd: string;
  /** Absolute path to the launcher repo, so adapters can compose tool paths. */
  readonly launcherRepoRoot: string;
}

/**
 * Per-workspace AI-provider override (endpoint / key / model). The launcher
 * owns the *contract* — one shape, dispatched uniformly across CLIs — while
 * each adapter owns the *format* (claude → `.claude/settings.local.json`,
 * codex → `.codex/config.toml` + `.codex/env.json`). Superset shape: `authMode`
 * is claude-only (which header carries the key), `wireApi` is codex-only
 * (Responses vs Chat Completions). Fields are optional/nullable so the same
 * shape serves both the write-input (absent ⇒ unset) and the read-output
 * (null ⇒ not present in the file).
 */
export interface WorkspaceAiCred {
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  /** Codex only. */
  wireApi?: 'chat' | 'responses' | null;
  /** Claude only. */
  authMode?: 'x-api-key' | 'bearer';
}

export interface EnvOverrides {
  /**
   * Substrings that, when found anywhere in an env var name, cause the var to
   * be stripped from the spawn env. Layered on top of `spawn-env.ts`'s
   * baseline list. The substring match is the same `STRIP_TOKENS` semantics
   * used by `buildSpawnEnv`.
   */
  readonly strip?: readonly string[];
  readonly set?: Readonly<Record<string, string>>;
}

export interface CliAdapter {
  readonly id: string;                          // 'claude' | 'codex' | 'shell'
  readonly displayName: string;
  /**
   * Short prefix used to name sessions (e.g. `c1`, `x1`, `sh1`). Helps scan a
   * mixed sidebar tree. Defaults to `id[0]` if omitted, but adapters whose
   * first character collides with another adapter (claude / codex both 'c')
   * MUST set this explicitly.
   */
  readonly namePrefix?: string;
  readonly capabilities: {
    readonly parallelPerCwd: boolean;
    readonly resumeLast: boolean;
    readonly resumeById: boolean;
    readonly transcriptDiscovery: 'fs-watch' | 'subprocess' | 'none';
    /**
     * The adapter mints its OWN session id at spawn. On a FRESH spawn the
     * launcher generates a uuid, threads it through `composeCommand`'s resume
     * `{sessionId}` intent (the CLI creates-or-reopens that id), and persists
     * it as `resumeHint` immediately — so a later reattach resumes BY ID, not
     * via fragile `--continue`/last. Requires the CLI's session-id flag to
     * create-if-missing (e.g. pi `--session-id`). Adapters that instead harvest
     * the id post-spawn (fs-watch / subprocess discovery) leave this falsy.
     */
    readonly assignsSessionId?: boolean;
  };

  /**
   * Translate the base command (from `WEB_TERMINAL_COMMAND` / template) +
   * resume intent into the final argv. For claude:
   *   base + 'last'    → [...base, '--continue']
   *   base + { id }    → [...base, '--resume', id]
   * For codex (M2):
   *   base + 'last'    → [...base, 'resume', '--last']
   *   base + { id }    → [...base, 'resume', id]
   */
  composeCommand(base: readonly string[], ctx: SpawnContext): readonly string[];

  /** Optional per-CLI env adjustments on top of `spawn-env.ts`'s baseline. */
  envOverrides?(parent: NodeJS.ProcessEnv): EnvOverrides;

  /**
   * Optional per-spawn env contribution. Unlike `envOverrides` (static, no
   * spawn context), this receives the full `SpawnContext` so adapters can
   * compute env values that depend on the workspace cwd — e.g. `CODEX_HOME`
   * pointing at `<cwd>/.codex`. Merged into the spawn env AFTER
   * `envOverrides` so this takes precedence for overlapping keys.
   *
   * Intentionally narrow: this is *launcher plumbing* (where to find files),
   * NOT a back-door for injecting provider config (keys/URLs) — those live
   * in the workspace's own files (`.claude/settings*.json`,
   * `.codex/config.toml`) and are read by the CLI directly.
   */
  composeEnv?(ctx: SpawnContext): Record<string, string>;

  /**
   * Workspace-creation hook. The launcher calls this once for every adapter
   * enabled on a workspace. Responsible for technical wiring (writing
   * `.mcp.json`, adding trust entries to global config, etc.) — NOT for
   * instruction files like CLAUDE.md / AGENTS.md (template README covers
   * the cross-CLI guidance).
   */
  bootstrap?(ctx: BootstrapContext): Promise<void>;

  /**
   * Read/write the workspace's per-CLI AI-provider override. The launcher
   * dispatches uniformly; each adapter renders the shared `WorkspaceAiCred`
   * into (and parses it out of) its own native config files. An empty cred
   * resets — the adapter deletes its config so the CLI falls back to global.
   * Absent on adapters with no configurable provider (shell).
   */
  writeAiConfig?(cwd: string, cred: WorkspaceAiCred): Promise<void>;
  readAiConfig?(cwd: string): Promise<WorkspaceAiCred | null>;

  // ── Transcript detection (used only when capabilities.transcriptDiscovery === 'fs-watch')
  transcriptDir?(cwd: string): string;
  transcriptFileRe?: RegExp;
  extractSessionId?(filename: string): string | null;

  /** Subprocess discovery (capabilities.transcriptDiscovery === 'subprocess'). */
  listOnDisk?(cwd: string): Promise<readonly OnDiskSession[]>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, CliAdapter>();
  private defaultId: string | null = null;

  register(adapter: CliAdapter, opts: { default?: boolean } = {}): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
    if (opts.default || this.defaultId === null) this.defaultId = adapter.id;
  }

  get(id: string): CliAdapter | undefined {
    return this.adapters.get(id);
  }

  /** Returns the registered adapter for `id`, falling back to the default. */
  resolve(id: string | null | undefined): CliAdapter {
    if (id) {
      const a = this.adapters.get(id);
      if (a) return a;
    }
    const fallback = this.defaultId ? this.adapters.get(this.defaultId) : undefined;
    if (!fallback) {
      throw new Error('AdapterRegistry has no adapters registered');
    }
    return fallback;
  }

  list(): readonly CliAdapter[] {
    return Array.from(this.adapters.values());
  }
}
