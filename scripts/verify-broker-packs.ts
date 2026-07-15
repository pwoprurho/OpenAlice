/** Verify generated Broker Pack catalogs and import every release artifact. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as tar from 'tar'

import {
  BROKER_PACK_API_VERSION,
  INSTALLABLE_BROKER_ENGINES,
  type InstallableBrokerEngine,
} from '../src/core/broker-packs.js'
import {
  brokerPackCatalogFileName,
  type BrokerPackReleaseAsset,
  type BrokerPackReleaseCatalog,
} from '../src/core/broker-pack-catalog.js'

const repoRoot = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')) as { version: string }
const outputArg = process.argv.indexOf('--out-dir')
const outDir = resolve(repoRoot, outputArg >= 0 ? process.argv[outputArg + 1] : 'dist/broker-packs')
const catalogPath = resolve(outDir, brokerPackCatalogFileName(packageJson.version))
const catalog = parseCatalog(JSON.parse(await readFile(catalogPath, 'utf8')))

const expectedEngines = new Set<string>(INSTALLABLE_BROKER_ENGINES)
const actualEngines = new Set(catalog.packs.map((asset) => asset.engine))
if (catalog.packs.length !== expectedEngines.size || actualEngines.size !== expectedEngines.size) {
  throw new Error(`Broker Pack catalog must contain each engine exactly once; got ${catalog.packs.map((row) => row.engine).join(', ')}`)
}
for (const engine of expectedEngines) {
  if (!actualEngines.has(engine)) throw new Error(`Broker Pack catalog is missing ${engine}`)
}

const tempRoot = await mkdtemp(resolve(tmpdir(), 'openalice-broker-pack-verify-'))
try {
  for (const asset of catalog.packs) await verifyAsset(asset, tempRoot)
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}

console.log(`[broker-packs] verified ${catalog.packs.length} release artifacts for ${process.platform}-${process.arch}`)

function parseCatalog(raw: unknown): BrokerPackReleaseCatalog {
  if (!raw || typeof raw !== 'object') throw new Error('Broker Pack catalog is not an object')
  const row = raw as Partial<BrokerPackReleaseCatalog>
  if (
    row.schemaVersion !== 1
    || row.openAliceVersion !== packageJson.version
    || row.platform !== process.platform
    || row.arch !== process.arch
    || !Array.isArray(row.packs)
  ) {
    throw new Error(`Broker Pack catalog does not match OpenAlice ${packageJson.version} on ${process.platform}-${process.arch}`)
  }
  return row as BrokerPackReleaseCatalog
}

async function verifyAsset(asset: BrokerPackReleaseAsset, root: string): Promise<void> {
  if (!INSTALLABLE_BROKER_ENGINES.includes(asset.engine as InstallableBrokerEngine)) {
    throw new Error(`Unknown Broker Pack engine: ${asset.engine}`)
  }
  if (asset.version !== packageJson.version) throw new Error(`${asset.engine} version mismatch: ${asset.version}`)
  if (asset.apiVersion !== BROKER_PACK_API_VERSION) throw new Error(`${asset.engine} API mismatch: ${asset.apiVersion}`)
  if (basename(asset.file) !== asset.file) throw new Error(`${asset.engine} has an unsafe asset filename`)
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`${asset.engine} has an invalid SHA-256`)

  const archive = resolve(outDir, asset.file)
  const archiveStat = await stat(archive)
  if (archiveStat.size !== asset.size) {
    throw new Error(`${asset.engine} size mismatch: catalog=${asset.size}, file=${archiveStat.size}`)
  }
  const digest = await sha256File(archive)
  if (digest !== asset.sha256) throw new Error(`${asset.engine} SHA-256 mismatch`)

  const packageRoot = resolve(root, asset.engine)
  await mkdir(packageRoot)
  await tar.x({ file: archive, cwd: packageRoot, strict: true, preservePaths: false })
  const pkg = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
  if (pkg.name !== `@traderalice/uta-broker-${asset.engine}` || pkg.version !== packageJson.version) {
    throw new Error(`${asset.engine} archive package identity mismatch`)
  }

  const [realRoot, realEntry] = await Promise.all([
    realpath(packageRoot),
    realpath(resolve(packageRoot, asset.entry)),
  ])
  if (realEntry === realRoot || !realEntry.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`${asset.engine} entry escapes its extracted archive`)
  }

  verifyModuleInCleanProcess(asset.engine, realEntry, packageRoot)
  await rm(packageRoot, { recursive: true, force: true })
  console.log(`[broker-packs] verified ${asset.engine} (${formatBytes(asset.size)})`)
}

function verifyModuleInCleanProcess(engine: InstallableBrokerEngine, entry: string, cwd: string): void {
  const script = [
    'const m = await import(process.env.BROKER_PACK_ENTRY)',
    'if (m.BROKER_PACK_API_VERSION !== Number(process.env.BROKER_PACK_API)) throw new Error("module API export mismatch")',
    'if (m.BROKER_ENGINE !== process.env.BROKER_PACK_ENGINE) throw new Error("module engine export mismatch")',
    'if (!m.configSchema || typeof m.createBroker !== "function") throw new Error("module is missing configSchema/createBroker")',
  ].join(';')
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_PATH: '',
      BROKER_PACK_ENTRY: pathToFileURL(entry).href,
      BROKER_PACK_API: String(BROKER_PACK_API_VERSION),
      BROKER_PACK_ENGINE: engine,
    },
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${engine} failed clean-process import:\n${(result.stderr || result.stdout).trim()}`)
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
