#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { assertDesktopPackage } from './assert-desktop-package.mjs'
import { buildDesktopPackagedSmokePlan } from './desktop-packaged-smoke-plan.mjs'
import { packagedElectronExecutable } from './smoke-packaged-toolchain.mjs'
import { startWorkspaceAcceptanceAiMock } from './workspace-acceptance-ai-mock.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const plan = buildDesktopPackagedSmokePlan(process.argv.slice(2), process.env)
const {
  keep,
  onboarding,
  realData,
  signed,
  skipBuild,
  skipPack,
  tradingMode,
  workspaceAcceptance,
} = plan.options

function printHelp() {
  console.log(`Usage: pnpm electron:smoke:packaged [options]

Build, pack, and launch the local unsigned OpenAlice.app with app.isPackaged=true.

Options:
  --skip-build   Reuse the existing dist/ backend and desktop JS
  --skip-pack    Reuse the existing dist/electron-app/OpenAlice.app
  --temp-data    Use isolated temporary data/workspace/global stores
  --real-data    Use real data explicitly (default; kept for compatibility)
  --onboarding   Build with first-run guide enabled, use temp data, run an
                 automated renderer onboarding smoke, then exit
  --trading-mode Use temp data, exercise lite -> readonly -> lite UTA lifecycle,
                 then exit
  --workspace-acceptance
                 Use temp data and prove a packaged Chat Workspace can execute
                 every injected CLI plus managed Pi using a CLI side effect
  --signed       Allow local macOS code signing (default disables it)
  --keep         Keep the temporary smoke data directory after the app exits
  -h, --help     Show this help
`)
}

if (plan.options.help) {
  printHelp()
  process.exit(0)
}

if (plan.errors.length > 0) {
  for (const error of plan.errors) console.error(error)
  printHelp()
  process.exit(1)
}

for (const warning of plan.warnings) console.warn(warning)

function run(label, command, commandArgs, extraEnv = {}) {
  console.log(`\n[desktop-smoke] ${label}`)
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close((err) => {
        if (err) reject(err)
        else if (port) resolve(port)
        else reject(new Error('unable to allocate a temporary port'))
      })
    })
  })
}

if (process.platform !== 'darwin' && !workspaceAcceptance) {
  console.error('[desktop-smoke] packaged .app smoke currently runs on macOS only')
  process.exit(1)
}

const aiMock = onboarding || workspaceAcceptance ? await startWorkspaceAcceptanceAiMock() : null
if (aiMock) {
  if (onboarding) {
    plan.buildEnv.VITE_OPENALICE_ONBOARDING_AI_BASE_URL = aiMock.baseUrl
    plan.launchEnv.OPENALICE_ONBOARDING_AI_BASE_URL = aiMock.baseUrl
  }
  if (workspaceAcceptance) {
    plan.launchEnv.OPENALICE_WORKSPACE_ACCEPTANCE_AI_BASE_URL = aiMock.baseUrl
  }
  console.log(`[desktop-smoke] AI mock: ${aiMock.baseUrl}`)
}

if (!skipBuild) run('build desktop bundle', 'pnpm', ['electron:build'], plan.buildEnv)
if (!skipPack) {
  run('vendor managed runtime', 'pnpm', ['vendor:runtime'])
  run(
    signed ? 'pack signed app directory' : 'pack unsigned app directory',
    'pnpm',
    ['-F', '@traderalice/desktop', 'run', 'pack'],
    signed ? plan.buildEnv : { ...plan.buildEnv, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  )
}

const packageResult = assertDesktopPackage()
const appPath = packageResult.appRoot
  ? packagedElectronExecutable(packageResult.appRoot, packageResult.platform)
  : null
if (!packageResult.ok || !appPath || !existsSync(appPath)) {
  for (const error of packageResult.errors) console.error(error)
  console.error('[desktop-smoke] packaged OpenAlice executable not found; run without --skip-pack first')
  process.exit(1)
}

const smokeRoot = realData ? null : mkdtempSync(join(tmpdir(), 'openalice-desktop-smoke-'))
const smokeHome = smokeRoot ? join(smokeRoot, 'home') : null
const smokeWorkspaces = smokeRoot ? join(smokeRoot, 'workspaces') : null
const smokeGlobal = smokeRoot ? join(smokeRoot, 'global') : null

const pathAdditions = [
  process.env['OPENALICE_EXTRA_AGENT_PATH'],
  join(homedir(), 'Library', 'pnpm'),
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), '.local', 'bin'),
].filter(Boolean)

const env = {
  ...process.env,
  ...plan.launchEnv,
  PATH: [process.env['PATH'], ...pathAdditions].filter(Boolean).join(delimiter),
  OPENALICE_EXTRA_AGENT_PATH: pathAdditions.join(delimiter),
}

for (const key of plan.unsetLaunchEnv) delete env[key]

if (onboarding || tradingMode || workspaceAcceptance) {
  env.OPENALICE_UTA_PORT = String(await getAvailablePort())
}

if (!realData && smokeHome && smokeWorkspaces && smokeGlobal) {
  env.OPENALICE_HOME = smokeHome
  env.AQ_LAUNCHER_ROOT = smokeWorkspaces
  env.OPENALICE_GLOBAL_DIR = smokeGlobal
}

const receiptPath = workspaceAcceptance
  ? process.env['OPENALICE_SMOKE_RECEIPT_PATH']?.trim() || join(smokeRoot, 'workspace-acceptance-receipt.json')
  : null
if (receiptPath) env.OPENALICE_SMOKE_RECEIPT_PATH = receiptPath

console.log('\n[desktop-smoke] launching packaged app')
console.log(`[desktop-smoke] app: ${appPath}`)
if (realData) {
  console.log('[desktop-smoke] data: real ~/.openalice (default)')
} else if (smokeHome && smokeWorkspaces && smokeGlobal) {
  console.log(`[desktop-smoke] data: ${smokeHome}`)
  console.log(`[desktop-smoke] workspaces: ${smokeWorkspaces}`)
  console.log(`[desktop-smoke] global provider keys: ${smokeGlobal}`)
}
if (onboarding) {
  console.log('[desktop-smoke] onboarding smoke: enabled; app exits automatically after the renderer probe')
  console.log(`[desktop-smoke] onboarding UTA port: ${env.OPENALICE_UTA_PORT}`)
} else if (tradingMode) {
  console.log('[desktop-smoke] trading-mode smoke: lite -> readonly -> lite; app exits automatically')
  console.log(`[desktop-smoke] trading-mode UTA port: ${env.OPENALICE_UTA_PORT}`)
} else if (workspaceAcceptance) {
  console.log('[desktop-smoke] workspace acceptance: packaged CLI contract + managed Pi side effect')
  console.log(`[desktop-smoke] acceptance receipt: ${receiptPath}`)
  console.log(`[desktop-smoke] acceptance UTA port: ${env.OPENALICE_UTA_PORT}`)
} else {
  console.log('[desktop-smoke] close the app window or press Ctrl-C here to stop')
}

const child = spawn(appPath, [], {
  cwd: repoRoot,
  stdio: 'inherit',
  env,
})

const cleanup = () => {
  aiMock?.server.close()
  if (keep || realData || !smokeRoot) return
  rmSync(smokeRoot, { recursive: true, force: true })
}

process.on('SIGINT', () => {
  child.kill('SIGTERM')
})
process.on('SIGTERM', () => {
  child.kill('SIGTERM')
})

child.on('exit', (code, signal) => {
  let finalCode = code ?? 0
  if (!signal && workspaceAcceptance && finalCode === 0) {
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      const failedChecks = Object.entries(receipt.checks ?? {})
        .filter(([, ok]) => ok !== true)
        .map(([name]) => name)
      if (failedChecks.length > 0) throw new Error(`failed receipt checks: ${failedChecks.join(', ')}`)
      if (aiMock.stats.acceptanceToolTurns < 1 || aiMock.stats.acceptanceFinalTurns < 1) {
        throw new Error(`mock did not observe both Pi turns: ${JSON.stringify(aiMock.stats)}`)
      }
      console.log(`[desktop-smoke] workspace acceptance receipt: ${JSON.stringify(receipt)}`)
    } catch (err) {
      finalCode = 1
      console.error(`[desktop-smoke] invalid workspace acceptance receipt: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  cleanup()
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(finalCode)
})

if (onboarding || tradingMode || workspaceAcceptance) {
  setTimeout(() => {
    console.error('[desktop-smoke] automated packaged smoke timed out')
    child.kill('SIGTERM')
  }, 180_000).unref()
}
