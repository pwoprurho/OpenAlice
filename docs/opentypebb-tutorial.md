# OpenTypeBB Integration

This guide owns OpenAlice's integration with `@traderalice/opentypebb`: the
in-process market-data SDK, provider configuration, HTTP mount, and standalone
package development.

Related route: [[docs/project-structure.md]].

## Current Topology

OpenTypeBB is a first-class workspace package under `packages/opentypebb/`.
Alice creates one in-process `QueryExecutor` and builds typed equity, crypto,
currency, commodity, ETF, index, derivatives, and economy clients around it.
There is no Python sidecar and no `backend: openbb-api` switch in the current
configuration.

The same executor is mounted into Alice's Hono app at:

```text
/api/market-data-v1
```

In `pnpm dev`, Vite normally serves the UI on `http://localhost:5173` and
proxies API requests to Alice (normally port 47331). The package can also run a
standalone OpenBB-compatible server on port 6901 for package development or
external consumers.

## Start and Verify the Integrated Path

```bash
pnpm install
pnpm dev
```

Useful checks:

```bash
curl http://127.0.0.1:47331/api/market-data-v1/widgets.json
curl "http://127.0.0.1:47331/api/market-data-v1/equity/price/quote?symbol=AAPL&provider=yfinance"
```

The configured web port may differ; `data/config/ports.json` and Guardian's
startup log are authoritative. The integrated market-data routes share Alice's
normal web/auth boundary.

## Configuration

Market-data configuration lives in
`<OPENALICE_HOME>/data/config/market-data.json`. Defaults are applied by
`src/core/config.ts`:

```json
{
  "enabled": true,
  "providers": {
    "equity": "yfinance",
    "crypto": "yfinance",
    "currency": "yfinance",
    "commodity": "yfinance"
  },
  "extraVendors": [],
  "providerKeys": {},
  "hub": {
    "enabled": true,
    "baseUrl": "https://traderhub.openalice.ai"
  }
}
```

- `providers` selects the default provider per asset class. ETF, index, and
  derivatives routes use the equity provider unless the caller explicitly
  chooses another provider.
- `extraVendors` adds regional/specialized equity search sources without
  replacing the always-on primary vendor.
- `providerKeys` holds user-supplied data-vendor keys. Global provider-key
  values fill gaps; local config values win.
- `hub` enables hosted public/reference data and keyed-provider proxy fallback.
  Disable it or change `baseUrl` for a fully local/self-hosted deployment.

The HTTP mount reads provider/key config lazily per request, and optional-vendor
search reads `extraVendors` per search. Alice's long-lived typed SDK clients are
constructed during startup, so restart Alice when validating a changed primary
provider or credential through agent tools unless that exact settings flow
explicitly rebuilds the client.

## Vendor Discovery

Do not maintain a copied provider inventory in this guide. Providers expose
their own credential declarations and optional `vendorMeta`; the runtime joins
that self-description to the current configuration.

The agent-facing tools are:

- `listMarketVendors` — list available vendor ids, enabled state, keyless
  status, coverage, and symbol/search conventions;
- `setMarketVendor` — toggle an optional vendor in `extraVendors`, effective on
  the next search.

The Market Data UI exposes the same optional-vendor state. Use this discovery
loop before assuming a market is unsupported: list vendors, read the vendor's
usage note, enable it if needed, then search again.

## Code Paths

| Path | Responsibility |
|---|---|
| `packages/opentypebb/src/` | Provider framework, standard models, routers, providers, standalone server |
| `src/domain/market-data/client/typebb/` | Alice SDK clients and route mapping |
| `src/domain/market-data/credential-map.ts` | OpenAlice key names → provider credential fields |
| `src/domain/market-data/vendors.ts` | Runtime vendor catalog and `extraVendors` updates |
| `src/server/opentypebb.ts` | Mount package routers into Alice's Hono app |
| `src/main.ts` | Construct clients and register market-data tools |
| `src/webui/plugin.ts` | Mount `/api/market-data-v1` with live config getters |
| `ui/src/pages/MarketDataPage.tsx` | Provider/hub/vendor configuration surface |

## Add or Change a Provider

Provider behavior belongs in `packages/opentypebb/src/providers/<id>/`.
Register it through the package app loader and keep its models/tests beside the
provider. If it should appear in the optional vendor picker, define `vendorMeta`
on the provider rather than adding a separate prose table elsewhere.

When a new credential name is exposed to users, update both the market-data
config schema and `src/domain/market-data/credential-map.ts`. When a new asset
class/route lands, update Alice's route map/client and the HTTP default-provider
resolver together.

## Standalone Package Server

Run the package directly:

```bash
pnpm -F @traderalice/opentypebb dev
```

Environment:

- `OPENTYPEBB_PORT` — listen port, default `6901`;
- `FMP_API_KEY` — optional default FMP credential;
- callers may also pass `X-OpenBB-Credentials` for standalone requests.

Standalone routes use the package's native OpenBB-compatible paths without
Alice's `/api/market-data-v1` prefix.

## Verification

```bash
pnpm -F @traderalice/opentypebb typecheck
pnpm vitest run packages/opentypebb/src
npx tsc --noEmit
pnpm test
```

For live keyed-provider verification, use explicit integration credentials and
the focused suites under `src/domain/market-data/__test__/e2e/`. Do not make
network/keyed tests a silent prerequisite for the normal unit suite.
