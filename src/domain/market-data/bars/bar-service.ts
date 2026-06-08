/**
 * Federated bar layer — service.
 *
 * `getBars(ref, opts)` resolves a bar request to a single source and fetches
 * OHLCV, tagging the result with source metadata. `searchBarSources(query)`
 * surfaces candidate sources for an asset.
 *
 * Phase 0 scope: the vendor branch is fully wired; the UTA branch calls
 * `UTAAccountSDK.getHistorical` (404s until the Phase-1 server route + a
 * per-broker `getHistorical` land). `searchBarSources` is vendor-only here —
 * the UTA search side (and the `ContractSearchResult` wire-shape fix) lands in
 * Phase 1 alongside CCXT. No Phase-0 consumer calls `searchBarSources`.
 */

import type { BarParams, BarInterval, Bar } from '@traderalice/uta-protocol'
import { aggregateSymbolSearch, type AssetClass } from '../aggregate-search.js'
import type {
  BarService,
  BarServiceDeps,
  BarSourceRef,
  BarSourceCandidate,
  GetBarsOpts,
  BarsResult,
  OhlcvBar,
  BarMeta,
  BarCapability,
} from './types.js'
import { formatBarId, parseBarId } from './types.js'

/** Hard ceiling on bars returned by any single fetch (explosion guard). */
const MAX_BARS = 5000

/** Vendor → bar capability (honest-ish defaults; vendors mostly serve delayed). */
const VENDOR_CAPABILITY: Record<string, BarCapability> = {
  yfinance: 'delayed',
  fmp: 'delayed',
}

const BAR_INTERVALS: readonly BarInterval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']

function toBarInterval(interval: string): BarInterval {
  return (BAR_INTERVALS as readonly string[]).includes(interval)
    ? (interval as BarInterval)
    : '1d'
}

// ---- window heuristics (legacy behavior-preserving; lifted from tool/analysis.ts) ----

function getCalendarDays(interval: string): number {
  const match = interval.match(/^(\d+)([dwhm])$/)
  if (!match) return 365
  const n = parseInt(match[1], 10)
  switch (match[2]) {
    case 'd': return n * 730
    case 'w': return n * 1825
    case 'h': return n * 90
    case 'm': return n * 30
    default: return 365
  }
}

/** Approximate calendar days per bar — used to size a count-bounded window. */
function perBarDays(interval: string): number {
  const match = interval.match(/^(\d+)([dwhm])$/)
  if (!match) return 1.6
  const n = parseInt(match[1], 10)
  switch (match[2]) {
    case 'd': return n * 1.6
    case 'w': return n * 7.5
    case 'h': return n * 0.2
    case 'm': return n * 0.05
    default: return 1.6
  }
}

function startDateFor(opts: GetBarsOpts): string {
  if (opts.start) return opts.start
  const anchor = opts.asOf ?? opts.end
  const end = anchor ? new Date(anchor) : new Date()
  const days = opts.count != null
    ? Math.max(getCalendarDays(opts.interval), Math.ceil(opts.count * perBarDays(opts.interval)) + 5)
    : getCalendarDays(opts.interval)
  const start = new Date(end)
  start.setDate(start.getDate() - days)
  return start.toISOString().slice(0, 10)
}

// ---- bar shaping ----

function isFullBar(d: Record<string, unknown>): boolean {
  return d.close != null && d.open != null && d.high != null && d.low != null
}

function dateOf(bar: Bar): string {
  const iso = bar.timestamp.toISOString()
  // Daily/weekly bars land at UTC midnight → keep date-only; intraday keeps time.
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
}

function barToOhlcv(bar: Bar): OhlcvBar {
  return {
    date: dateOf(bar),
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: bar.volume === '' || bar.volume == null ? null : Number(bar.volume),
  }
}

function buildMeta(symbol: string, bars: OhlcvBar[], extra: Partial<BarMeta>): BarMeta {
  return {
    symbol,
    from: bars.length > 0 ? bars[0].date : '',
    to: bars.length > 0 ? bars[bars.length - 1].date : '',
    bars: bars.length,
    ...extra,
  }
}

/** Sort ascending, cap to MAX_BARS (keep most-recent), then truncate to `count`. */
function finalize(data: OhlcvBar[], count?: number): OhlcvBar[] {
  data.sort((a, b) => a.date.localeCompare(b.date))
  let out = data
  if (out.length > MAX_BARS) {
    console.warn(`[bar-service] result ${out.length} bars exceeds MAX_BARS=${MAX_BARS}; keeping most recent`)
    out = out.slice(-MAX_BARS)
  }
  if (count != null && out.length > count) out = out.slice(-count)
  return out
}

export function createBarService(deps: BarServiceDeps): BarService {
  // -------- vendor fetch --------
  async function getVendorBars(
    provider: string,
    assetClass: AssetClass,
    symbol: string,
    opts: GetBarsOpts,
  ): Promise<BarsResult> {
    const start_date = startDateFor(opts)
    let raw: Array<Record<string, unknown>>
    switch (assetClass) {
      case 'equity':
        raw = await deps.equityClient.getHistorical({ symbol, start_date, interval: opts.interval, provider })
        break
      case 'crypto':
        raw = await deps.cryptoClient.getHistorical({ symbol, start_date, interval: opts.interval, provider })
        break
      case 'currency':
        raw = await deps.currencyClient.getHistorical({ symbol, start_date, interval: opts.interval, provider })
        break
      case 'commodity':
        raw = await deps.commodityClient.getSpotPrices({ symbol, start_date, provider })
        break
    }
    const filtered = finalize(raw.filter(isFullBar) as OhlcvBar[], opts.count)
    return {
      bars: filtered,
      meta: buildMeta(symbol, filtered, {
        source: 'vendor',
        sourceId: provider,
        barId: formatBarId(provider, symbol),
        provider,
        barCapability: VENDOR_CAPABILITY[provider],
      }),
    }
  }

  // -------- uta (broker) fetch --------
  async function getUtaBars(sourceId: string, barId: string, opts: GetBarsOpts): Promise<BarsResult> {
    const acct = await deps.utaManager.get(sourceId)
    if (!acct) throw new Error(`UTA source "${sourceId}" not found for barId "${barId}"`)
    const params: BarParams = {
      interval: toBarInterval(opts.interval),
      start: opts.start ? new Date(opts.start) : undefined,
      end: (opts.end ?? opts.asOf) ? new Date((opts.end ?? opts.asOf)!) : undefined,
      limit: opts.count,
    }
    const wireBars = await acct.getHistorical({ aliceId: barId }, params)
    const bars = finalize(wireBars.map(barToOhlcv), opts.count)
    const symbol = parseBarId(barId)?.nativeSymbol ?? barId
    return {
      bars,
      meta: buildMeta(symbol, bars, {
        source: 'uta',
        sourceId,
        barId,
        barCapability: 'realtime',
      }),
    }
  }

  return {
    async searchBarSources(query, opts) {
      const limit = opts?.limit ?? 20
      // Phase 0: vendor side only. UTA-source candidates + the
      // ContractSearchResult wire-shape fix land in Phase 1 with CCXT.
      const vendor = await aggregateSymbolSearch(deps.marketSearch, query, limit)
      return vendor.map((r): BarSourceCandidate => {
        const symbol = String(r.symbol ?? r.id ?? '')
        const provider = deps.vendorProviders[r.assetClass]
        return {
          barId: formatBarId(provider, symbol),
          source: 'vendor',
          sourceId: provider,
          symbol,
          assetClass: r.assetClass,
          label: r.name ? `${symbol} · ${r.name} (${provider})` : `${symbol} (${provider})`,
          barCapability: VENDOR_CAPABILITY[provider],
        }
      })
    },

    async getBars(ref, opts) {
      if ('symbol' in ref) {
        const provider = deps.vendorProviders[ref.assetClass]
        return getVendorBars(provider, ref.assetClass, ref.symbol, opts)
      }
      // barId form
      const parsed = parseBarId(ref.barId)
      if (!parsed) throw new Error(`Invalid barId "${ref.barId}" (expected "sourceId|nativeSymbol")`)
      const isUta = await deps.utaManager.has(parsed.sourceId)
      if (isUta) return getUtaBars(parsed.sourceId, ref.barId, opts)
      // vendor barId — needs an assetClass to route to the right client
      if (!ref.assetClass) {
        throw new Error(
          `Vendor barId "${ref.barId}" needs an assetClass to route. Pass { barId, assetClass } or use { symbol, assetClass }.`,
        )
      }
      return getVendorBars(parsed.sourceId, ref.assetClass, parsed.nativeSymbol, opts)
    },
  }
}
