import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tar from 'tar'

import { getCurrentVersion } from '../../core/version.js'
import { brokerPackCatalogFileName } from '../../core/broker-pack-catalog.js'

let home: string
let fixture: string
let server: Server | undefined
let savedEnv: Record<string, string | undefined>

beforeEach(async () => {
  savedEnv = {
    OPENALICE_HOME: process.env['OPENALICE_HOME'],
    OPENALICE_BROKER_PACK_CATALOG_URL: process.env['OPENALICE_BROKER_PACK_CATALOG_URL'],
    OPENALICE_BROKER_PACK_ALLOW_WORKSPACE: process.env['OPENALICE_BROKER_PACK_ALLOW_WORKSPACE'],
  }
  home = await mkdtemp(resolve(tmpdir(), 'openalice-broker-pack-home-'))
  fixture = await mkdtemp(resolve(tmpdir(), 'openalice-broker-pack-fixture-'))
  process.env['OPENALICE_HOME'] = home
  process.env['OPENALICE_BROKER_PACK_ALLOW_WORKSPACE'] = '0'
})

afterEach(async () => {
  if (server) await new Promise<void>((done) => server!.close(() => done()))
  server = undefined
  await rm(home, { recursive: true, force: true })
  await rm(fixture, { recursive: true, force: true })
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
})

describe('broker-pack installer', () => {
  it('downloads, verifies, and atomically activates a version-matched pack', async () => {
    const version = getCurrentVersion()
    const payload = resolve(fixture, 'payload')
    await mkdir(resolve(payload, 'dist'), { recursive: true })
    await writeFile(resolve(payload, 'package.json'), JSON.stringify({
      name: '@traderalice/uta-broker-ccxt',
      version,
      type: 'module',
      main: './dist/index.js',
    }))
    await writeFile(resolve(payload, 'dist/index.js'), 'export const API_VERSION = 1\n')

    const archiveName = `OpenAlice-Broker-ccxt-${version}-${process.platform}-${process.arch}.tgz`
    const archive = resolve(fixture, archiveName)
    await tar.c({ gzip: true, cwd: payload, file: archive }, ['package.json', 'dist'])
    const bytes = await readFile(archive)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const catalogName = brokerPackCatalogFileName(version)
    const catalog = JSON.stringify({
      schemaVersion: 1,
      openAliceVersion: version,
      platform: process.platform,
      arch: process.arch,
      packs: [{
        engine: 'ccxt', version, apiVersion: 1, file: archiveName,
        entry: 'dist/index.js', sha256, size: bytes.length,
      }],
    })

    server = createServer((req, res) => {
      if (req.url === `/${catalogName}`) {
        res.setHeader('content-type', 'application/json')
        res.end(catalog)
      } else if (req.url === `/${archiveName}`) {
        res.setHeader('content-length', String(bytes.length))
        res.end(bytes)
      } else {
        res.statusCode = 404
        res.end()
      }
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address')
    process.env['OPENALICE_BROKER_PACK_CATALOG_URL'] = `http://127.0.0.1:${address.port}/${catalogName}`

    vi.resetModules()
    const { installBrokerPack, getBrokerPackLocalStatus } = await import('./installer.js')
    const installed = await installBrokerPack('ccxt')
    expect(installed).toMatchObject({ engine: 'ccxt', installed: true, source: 'downloaded', version })
    await expect(getBrokerPackLocalStatus('ccxt')).resolves.toMatchObject({
      engine: 'ccxt', installed: true, source: 'downloaded', version,
    })

    const { resolveActiveBrokerPack } = await import('../../core/broker-packs.js')
    const active = await resolveActiveBrokerPack('ccxt')
    expect(active?.manifest).toMatchObject({ engine: 'ccxt', version, contentId: sha256.slice(0, 16) })
    expect(await readFile(active!.entry, 'utf8')).toContain('API_VERSION = 1')
  })

  it('does not activate a pack whose checksum differs from the catalog', async () => {
    const version = getCurrentVersion()
    const archiveName = `OpenAlice-Broker-ccxt-${version}-${process.platform}-${process.arch}.tgz`
    const bytes = Buffer.from('not really a tarball')
    const catalogName = brokerPackCatalogFileName(version)
    const catalog = JSON.stringify({
      schemaVersion: 1,
      openAliceVersion: version,
      platform: process.platform,
      arch: process.arch,
      packs: [{
        engine: 'ccxt', version, apiVersion: 1, file: archiveName,
        entry: 'dist/index.js', sha256: '0'.repeat(64), size: bytes.length,
      }],
    })
    server = createServer((req, res) => {
      if (req.url === `/${catalogName}`) res.end(catalog)
      else { res.setHeader('content-length', String(bytes.length)); res.end(bytes) }
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address')
    process.env['OPENALICE_BROKER_PACK_CATALOG_URL'] = `http://127.0.0.1:${address.port}/${catalogName}`

    vi.resetModules()
    const { installBrokerPack, getBrokerPackLocalStatus } = await import('./installer.js')
    await expect(installBrokerPack('ccxt')).rejects.toThrow(/checksum mismatch/i)
    await expect(getBrokerPackLocalStatus('ccxt')).resolves.toMatchObject({ installed: false, source: 'missing' })
  })
})
