/**
 * Headless task runner — the automation-dispatch primitive.
 *
 * Spawns an agent CLI's ONE-SHOT headless command (from
 * `adapter.composeHeadlessCommand`, prompt already placed) on a plain pipe and
 * waits for it to EXIT — the turn boundary that means the task is done.
 *
 * Differences from `probe.ts` (and why this is a separate primitive):
 *  - **Plain `child_process.spawn`, not node-pty.** Probe replays the user's
 *    real interactive TUI path (needs a PTY); a headless task wants clean,
 *    separated stdout/stderr — a PTY mangles the JSON stream with terminal
 *    control bytes (verified across all four adapters).
 *  - **Exit is the done signal.** One-shot modes (`-p` / `exec` / `run`) exit
 *    at the turn boundary, so we wait on exit rather than timeout-killing the
 *    way probe must (interactive TUIs never exit). The watchdog is a backstop
 *    (codex can hang under heavy logging).
 *  - **NOT routed through SessionPool/PersistentSession**, whose respawn-on-exit
 *    circuit is anti-semantic for a one-shot task (exit == completion).
 *
 * The launcher does NOT parse the output: the agent reports via `inbox_push`.
 * We only need the exit signal + a bounded output tail for diagnostics.
 */
import { spawn } from 'node:child_process';

import type { Logger } from './logger.js';

const KILL_GRACE_MS = 5_000;
const OUTPUT_TAIL_BYTES = 16 * 1024;

export interface HeadlessTaskArgs {
  /** Full argv WITH the prompt already placed (from composeHeadlessCommand). */
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Watchdog: SIGTERM at `timeoutMs`, SIGKILL after a grace window. */
  readonly timeoutMs: number;
  readonly logger: Logger;
}

export interface HeadlessTaskResult {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** True if the watchdog had to kill the process (timeout, not natural exit). */
  readonly killed: boolean;
  readonly durationMs: number;
  /** Last bytes of stdout/stderr — diagnostics only; not parsed for control flow. */
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

/**
 * Byte-accumulating tail sink. Buffers raw chunks and decodes UTF-8 ONCE at the
 * end — so a multi-byte sequence split across two `data` chunks isn't mangled
 * into U+FFFD at the seam (which per-chunk `.toString()` would do, corrupting
 * the very JSON tail an operator reads). Memory is bounded: once well over the
 * budget the chunks collapse to the last `maxBytes`.
 */
function makeTailSink(maxBytes: number): { push(c: Buffer): void; text(): string } {
  let chunks: Buffer[] = [];
  let total = 0;
  return {
    push(c) {
      chunks.push(c);
      total += c.length;
      if (total > maxBytes * 2) {
        const merged = Buffer.concat(chunks).subarray(-maxBytes);
        chunks = [merged];
        total = merged.length;
      }
    },
    text() {
      return Buffer.concat(chunks).subarray(-maxBytes).toString('utf8');
    },
  };
}

export async function runHeadlessTask(args: HeadlessTaskArgs): Promise<HeadlessTaskResult> {
  const { command, cwd, env, timeoutMs, logger } = args;
  const [argv0, ...argv1] = command;
  if (!argv0) throw new Error('headless: empty command');

  const start = Date.now();
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let killed = false;
  const outSink = makeTailSink(OUTPUT_TAIL_BYTES);
  const errSink = makeTailSink(OUTPUT_TAIL_BYTES);

  // KNOWN GAP (win32): plain shell-less spawn of a bare CLI name (`claude` etc.)
  // won't resolve the npm `.cmd` shim on Windows (post-CVE-2024-27980 Node
  // disabled that), so headless tasks ENOENT on win32. The interactive pool
  // avoids this by using node-pty (ConPTY resolves shims). NOT fixed with
  // `shell:true` — that would re-parse the prompt arg through cmd.exe and
  // re-open shell injection. Proper fix = resolve the shim path / cross-spawn.
  // Tracked for follow-up; primary targets (macOS dev, Linux cloud) are fine.
  const child = spawn(argv0, argv1, {
    cwd,
    env: env as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => outSink.push(d));
  child.stderr?.on('data', (d: Buffer) => errSink.push(d));

  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, sig) => {
      exitCode = code;
      signal = sig;
      resolve();
    });
    child.once('error', (err) => {
      // e.g. ENOENT (binary not on PATH) — 'exit' won't fire, so resolve here.
      logger.error('headless.spawn_error', { command: argv0, err });
      errSink.push(Buffer.from(String(err)));
      if (exitCode === null) exitCode = -1;
      resolve();
    });
  });

  // Watchdog armed BEFORE the await so it covers the wait: SIGTERM at
  // timeoutMs, SIGKILL after the grace window.
  const softKill = setTimeout(() => {
    killed = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  softKill.unref();
  const hardKill = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, timeoutMs + KILL_GRACE_MS);
  hardKill.unref();

  await exitPromise;
  clearTimeout(softKill);
  clearTimeout(hardKill);
  const durationMs = Date.now() - start;
  const stdoutTail = outSink.text();
  const stderrTail = errSink.text();

  logger.info('headless.complete', {
    command: argv0,
    durationMs,
    exitCode,
    signal,
    killed,
    stdoutBytes: stdoutTail.length,
    stderrBytes: stderrTail.length,
  });

  return { command, cwd, exitCode, signal, killed, durationMs, stdoutTail, stderrTail };
}
