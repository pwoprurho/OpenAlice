/** Download, validate, stage, and atomically activate optional broker packs. */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, resolve } from 'node:path'
import * as tar from 'tar'
import {
  BROKER_PACK_API_VERSION,
  BROKER_PACK_SCHEMA_VERSION,
  brokerPackActivePath,
  brokerPackEngineRoot,
  brokerPackReleasesRoot,
  resolveActiveBrokerPack,
  type BrokerPackActivePointer,
  type InstalledBrokerPackManifest,
  type InstallableBrokerEngine,
} from '../../core/broker-packs.js'
import {
  brokerPackCatalogFileName,
  type BrokerPackReleaseAsset,
  type BrokerPackReleaseCatalog,
} from '../../core/broker-pack-catalog.js'
import { getCurrentVersion } from '../../core/version.js'

const DEFAULT_BASE_URL = 'https://download.openalice.ai'
const MAX_PACK_BYTES = 512 * 1024 * 1024

export interface BrokerPackLocalStatus {
  engine: InstallableBrokerEngine | 'mock'
  installed: boolean
  source: 'builtin' | 'workspace' | 'downloaded' | 'missing' | 'broken'
  version?: string
  reason?: string
}

export async function getBrokerPackLocalStatus(engine: InstallableBrokerEngine | 'mock'): Promise<BrokerPackLocalStatus> {
  if (engine === 'mock') return { engine, installed: true, source: 'builtin', version: getCurrentVersion() }
  try {
    const active = await resolveActiveBrokerPack(engine)
    if (active) return { engine, installed: true, source: 'downloaded', version: active.manifest.version }
  } catch (err) {
    return { engine, installed: false, source: 'broken', reason: err instanceof Error ? err.message : String(err) }
  }
  if (workspacePacksAvailable()) {
    return { engine, installed: true, source: 'workspace', version: getCurrentVersion() }
  }
  return { engine, installed: false, source: 'missing' }
}

export async function installBrokerPack(engine: InstallableBrokerEngine): Promise<BrokerPackLocalStatus> {
  const engineRoot = brokerPackEngineRoot(engine)
  const lock = resolve(engineRoot, '.install.lock')
  await mkdir(engineRoot, { recursive: true })
  try {
    await mkdir(lock)
  } catch (err) {
    if (isCode(err, 'EEXIST')) throw new Error(`Another ${engine} broker-pack install is already running`)
    throw err
  }

  const workRoot = resolve(engineRoot, `.staging-${process.pid}-${Date.now()}`)
  try {
    const catalogUrl = resolveCatalogUrl()
    const catalog = await fetchCatalog(catalogUrl)
    const asset = catalog.packs.find((row) => row.engine === engine)
    if (!asset) throw new Error(`No ${engine} broker pack is published for ${process.platform}-${process.arch}`)
    validateAsset(asset)
    validateRequirements(asset)

    await mkdir(workRoot, { recursive: true })
    const archivePath = resolve(workRoot, basename(asset.file))
    const assetUrl = new URL(asset.file, catalogUrl).href
    await download(assetUrl, archivePath, asset.size)
    const actualSha = await sha256File(archivePath)
    if (actualSha !== asset.sha256) {
      throw new Error(`Broker-pack checksum mismatch: expected ${asset.sha256}, got ${actualSha}`)
    }

    const extracted = resolve(workRoot, 'payload')
    await mkdir(extracted, { recursive: true })
    await tar.x({ file: archivePath, cwd: extracted, strict: true, preservePaths: false })
    await validateExtractedPackage(extracted, engine, asset)

    const contentId = actualSha.slice(0, 16)
    const release = `${safePart(asset.version)}-${contentId}`
    const finalRoot = resolve(brokerPackReleasesRoot(engine), release)
    const installedAt = new Date().toISOString()
    const manifest: InstalledBrokerPackManifest = {
      schemaVersion: BROKER_PACK_SCHEMA_VERSION,
      apiVersion: BROKER_PACK_API_VERSION,
      engine,
      version: asset.version,
      entry: asset.entry,
      contentId,
      installedAt,
      sourceUrl: assetUrl,
    }
    await writeFile(resolve(extracted, 'broker-pack.json'), JSON.stringify(manifest, null, 2) + '\n')

    await mkdir(brokerPackReleasesRoot(engine), { recursive: true })
    try {
      await rename(extracted, finalRoot)
    } catch (err) {
      if (!isCode(err, 'EEXIST') && !isCode(err, 'ENOTEMPTY')) throw err
      await access(resolve(finalRoot, asset.entry))
    }

    const pointer: BrokerPackActivePointer = {
      schemaVersion: BROKER_PACK_SCHEMA_VERSION,
      engine,
      release,
      activatedAt: new Date().toISOString(),
    }
    const activePath = brokerPackActivePath(engine)
    const activeTmp = `${activePath}.${process.pid}.tmp`
    await writeFile(activeTmp, JSON.stringify(pointer, null, 2) + '\n')
    await rename(activeTmp, activePath)
    return { engine, installed: true, source: 'downloaded', version: asset.version }
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined)
    await rm(lock, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function fetchCatalog(url: string): Promise<BrokerPackReleaseCatalog> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Broker-pack catalog request failed: HTTP ${res.status}`)
  const raw = await res.json() as Partial<BrokerPackReleaseCatalog>
  const version = getCurrentVersion()
  if (
    raw.schemaVersion !== 1
    || raw.openAliceVersion !== version
    || raw.platform !== process.platform
    || raw.arch !== process.arch
    || !Array.isArray(raw.packs)
  ) {
    throw new Error(`Broker-pack catalog is incompatible with OpenAlice ${version} on ${process.platform}-${process.arch}`)
  }
  return raw as BrokerPackReleaseCatalog
}

function validateAsset(asset: BrokerPackReleaseAsset): void {
  if (asset.apiVersion !== BROKER_PACK_API_VERSION) throw new Error(`Broker-pack API ${asset.apiVersion} is unsupported`)
  if (!/^[A-Za-z0-9._-]+$/.test(asset.file) || basename(asset.file) !== asset.file) throw new Error('Invalid broker-pack asset name')
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid broker-pack checksum')
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PACK_BYTES) throw new Error('Invalid broker-pack size')
  if (!asset.entry || asset.entry.startsWith('/') || asset.entry.includes('..')) throw new Error('Invalid broker-pack entry')
}

function validateRequirements(asset: BrokerPackReleaseAsset): void {
  const libc = asset.requirements?.libc
  if (!libc) return
  const runtime = runtimeGlibcVersion()
  if (!runtime || compareNumericVersions(runtime, libc.minVersion) < 0) {
    throw new Error(`${asset.engine} requires glibc ${libc.minVersion}+; this system reports ${runtime ?? 'an unknown libc'}`)
  }
}

async function download(url: string, target: string, expectedSize: number): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok || !res.body) throw new Error(`Broker-pack download failed: HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_PACK_BYTES || declared > expectedSize + 1024) throw new Error('Broker-pack download is larger than published metadata')
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(target, { flags: 'wx' }))
  const downloaded = (await stat(target)).size
  if (downloaded !== expectedSize) throw new Error(`Broker-pack size mismatch: expected ${expectedSize}, got ${downloaded}`)
}

async function validateExtractedPackage(root: string, engine: InstallableBrokerEngine, asset: BrokerPackReleaseAsset): Promise<void> {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
  if (pkg.name !== `@traderalice/uta-broker-${engine}`) throw new Error(`Broker-pack package name mismatch for ${engine}`)
  if (pkg.version !== asset.version) throw new Error(`Broker-pack package version mismatch for ${engine}`)
  await access(resolve(root, asset.entry))
}

function resolveCatalogUrl(): string {
  const version = getCurrentVersion()
  const override = process.env['OPENALICE_BROKER_PACK_CATALOG_URL']?.trim()
  if (override) return override
  const base = (process.env['OPENALICE_BROKER_PACK_BASE_URL']?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '')
  return `${base}/${brokerPackCatalogFileName(version)}`
}

function workspacePacksAvailable(): boolean {
  if (process.env['OPENALICE_BROKER_PACK_ALLOW_WORKSPACE'] === '1') return true
  if (process.env['OPENALICE_BROKER_PACK_ALLOW_WORKSPACE'] === '0') return false
  return process.env['NODE_ENV'] === 'test'
    || process.env['OPENALICE_LAUNCHER'] === 'dev'
}

function runtimeGlibcVersion(): string | null {
  if (process.platform !== 'linux') return null
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }
  return report.header?.glibcVersionRuntime ?? null
}

function compareNumericVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-')
}

function isCode(err: unknown, code: string): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === code
}
