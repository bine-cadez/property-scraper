## Local development

Node.js 24 or newer is required (including for the Kyrage migration CLI).

```bash
cp .env.example .env
pnpm install
docker compose up -d db
pnpm migrate:generate
pnpm migrate:plan
pnpm migrate:apply
pnpm dev
```

Every API route requires the password stored in `AUTH_KEY`. Send it in the
`x-api-key` header, including for health checks:

```bash
curl -H "x-api-key: $AUTH_KEY" http://localhost:3000/health
```

Interactive OpenAPI documentation is available without authentication at
`http://localhost:3000/docs`. Use **Authorize** to set `x-api-key` before
trying a protected endpoint. It includes a beginner-friendly glossary and a
plain-language explanation of what every endpoint returns. The generated
OpenAPI document is also available as JSON at `/docs/json` and YAML at
`/docs/yaml`.

## Build a coherent live GURS graph

`sample-size` selects that many most-recent distinct ETN transactions from the
requested year. The importer resolves their sold building parts and parcels by
cadastral natural key, then downloads the complete one-hop property graph and
all related valuation rows. Related rows are not capped by `sample-size`.

```bash
pnpm ingest:gurs -- --sample-size=10000 --transaction-year=2025
```

The authenticated API accepts the same options:

```bash
curl -X POST http://localhost:3000/ingest/gurs \
  -H "content-type: application/json" \
  -H "x-api-key: $AUTH_KEY" \
  -d '{"sampleSize":10000,"transactionYear":2025}'
```

Each run loads temporary staging tables and only replaces the live KN/EV
tables after the full graph succeeds. The replacement, ETN-to-GURS resolution,
and map refresh commit together. Any failure preserves the previous live data.

Every successful GURS HTTP response is checkpointed in PostgreSQL immediately.
Temporary network failures and `429`/`5xx` responses are retried with backoff.
If a run still fails, rerunning the same sample and transaction year reuses the
saved responses instead of downloading them again. Checkpoints are deleted only
after the live replacement commits; abandoned checkpoints expire after seven
days.

Natural-key and EID predicates are sent as bounded CQL2 batches. Every upstream
request is paginated and results are deduplicated by EID. CLI progress is
emitted as JSON lines on stderr, including anchor, request, resolution, write,
skip, and coverage counts. The final summary is printed on stdout.

## Read API

All endpoints require `x-api-key`. List endpoints use an opaque `cursor`,
default to 50 rows, and accept at most 200:

```text
GET /gurs/sources
GET /gurs/statistics
GET /gurs/cadastral-municipalities
GET /gurs/addresses
GET /gurs/parcels
GET /gurs/buildings
GET /gurs/building-parts
GET /gurs/transactions
GET /gurs/code-lists
GET /gurs/search?q=Trubarjeva+10
```

Every collection except statistics has `/:id` detail routes. Building, part,
and parcel details include relationship counts and links for navigating their
addresses, parts, parcels, valuation units, and sales. Transaction details
include all ETN items and their resolved `eidDelStavbe`/`eidParcela`.

Filters are explicitly whitelisted. Common examples are `koId`,
`buildingTypeCode`, `areaMin`/`areaMax`,
`contractDateMin`/`contractDateMax`, `priceMin`/`priceMax`, text fields such as
`fullAddress`, and WGS84 `bbox=minLon,minLat,maxLon,maxLat`. Unknown filters are
rejected; callers cannot supply SQL or CQL.

## Map API

Mapbox Vector Tiles are available at:

```text
GET /map/tiles/{layer}/{z}/{x}/{y}.mvt
```

Layers are `properties`, `sales`, `parcels`, and `cadastral`. Properties and
sales cluster through zoom 11 and become individual pins at zoom 12. Building
footprints start at zoom 16, parcels at zoom 15, and cadastral boundaries at
zoom 8. Tiles are always viewport-limited by `ST_TileEnvelope`.

MapLibre must attach the API key to tile requests as well:

```js
const map = new maplibregl.Map({
  // ...
  transformRequest: (url) => ({
    url,
    headers: { "x-api-key": import.meta.env.VITE_GURS_API_KEY },
  }),
});
```

Set `CORS_ORIGINS` to a comma-separated allowlist (for example,
`http://localhost:5173`). Use `*` only for a public deployment.

## Docker

Run the API and PostGIS 17 with:

```bash
docker compose up --build
```

Kyrage manages ordinary columns and tables; versioned raw SQL manages PostGIS,
`pg_trgm`, geometry columns, and GiST indexes:

```bash
docker compose exec api pnpm migrate:generate
docker compose exec api pnpm migrate:apply
```

`migrate:apply` applies Kyrage first and then the idempotent SQL files under
`migrations/sql`. To apply only the spatial SQL migrations, run
`pnpm migrate:sql`.

The `Dockerfile` also contains a minimal `production` target:

```bash
docker build --target production -t property-scraper .
```
