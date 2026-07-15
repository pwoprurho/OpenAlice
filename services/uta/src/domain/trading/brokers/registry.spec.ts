import { afterEach, describe, expect, it } from 'vitest'

import { BrokerPackUnavailableError, clearBrokerEngineCache, loadBrokerEngine } from './registry.js'

const savedWorkspacePolicy = process.env['OPENALICE_BROKER_PACK_ALLOW_WORKSPACE']

afterEach(() => {
  if (savedWorkspacePolicy === undefined) delete process.env['OPENALICE_BROKER_PACK_ALLOW_WORKSPACE']
  else process.env['OPENALICE_BROKER_PACK_ALLOW_WORKSPACE'] = savedWorkspacePolicy
  clearBrokerEngineCache()
})

describe('broker engine registry', () => {
  it('keeps Mock built in while reporting an absent live engine without loading its SDK', async () => {
    process.env['OPENALICE_BROKER_PACK_ALLOW_WORKSPACE'] = '0'
    clearBrokerEngineCache()

    await expect(loadBrokerEngine('ccxt')).rejects.toMatchObject({
      name: 'BrokerPackUnavailableError',
      code: 'BROKER_PACK_UNAVAILABLE',
      engine: 'ccxt',
    } satisfies Partial<BrokerPackUnavailableError>)

    const mock = await loadBrokerEngine('mock')
    expect(mock.configSchema).toBeTruthy()
    expect(typeof mock.createBroker).toBe('function')
  })
})
