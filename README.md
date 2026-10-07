Production deployment on Hetzner, including GitHub auto-deploy, rollback, and
Aiven configuration, is documented in [DEPLOYMENT.md](./DEPLOYMENT.md).

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

Every collection except statistics has `/:id` detail routes. Building, building
part, and parcel details embed their related records as objects and arrays.
Transaction details include all ETN items and their resolved
`eidDelStavbe`/`eidParcela`.

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
zoom 8. Individual building and parcel features include `modelled_value`,
calculated as the sum of their valuation-unit values. Both layers accept
`valuationValueMin` and `valuationValueMax` filters. Tiles are always
viewport-limited by `ST_TileEnvelope`.

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

## House sale and rental advertisements

Advertisement inventory is stored independently of GURS records and completed
sales. Each ad is normalized to asking price, price basis, floor area, land
area, property type, sale or rent, location text, coordinates when the source
publishes them, source URL, and `scraped_at`.

Enabled by default:

- **RE/MAX Slovenia** (`re-max`) reads the public search index at
  `www.re-max.si`. `robots.txt` allows `/`. Requests stay on that host, use a
  descriptive user agent, and pause between calls. The import keeps Slovenia
  (`CountryID` 49) sale and rent rows that the site marks viewable. A street
  is stored only when the listing marks the address public; otherwise
  coordinates are labelled approximate. Photos are the public CDN URLs the
  site already publishes.
- **Keller Williams Slovenia** (`kw`) reads `https://kwslovenia.com/oglasi/prodaja`
  and `/oglasi/oddaja`. `robots.txt` allows those pages and asks for
  `Crawl-delay: 30`. The importer waits 30 seconds before every KW request.
  Listing pages do not publish coordinates. Ads whose slug or heading is
  outside Slovenia are omitted.
- **Oglasnik.si** (`oglasnik`) reads the public WordPress RSS feed
  `https://oglasnik.si/kategorija-oglasa/nepremicnine/feed/`. It is a recent
  classifieds feed, not a full market catalogue. Price, area, and place are
  taken from the article text. The feed mixes sale and rent, so a partial
  import does not retire ads that were not in that page.

`GET /listings/sources` reports every candidate and why a source is off.
Set `LISTING_SOURCES=re-max,oglasnik` to change the default set without a
code change. An explicit `--sources` list overrides that variable.

These sources were checked and left out. None of them are fetched by the
default import, and the client does not bypass challenges:

- **Nepremicnine.net** returns a Cloudflare challenge, and its
  [terms](https://www.nepremicnine.net/pogoji-uporabe.html) require a separate
  agreement for automated collection. Its
  [agency API](https://api.nepremicnine.net/docs/Nepremicnine.net%20API%20dokumentacija%20ent.pdf)
  needs an activated token.
- **Bolha** still has a house parser (`--sources=bolha`). A Cloudflare or
  captcha response fails that catalogue and does not deactivate stored ads.
  It is disabled unless selected because that access has been unreliable.
- **SI21** allows crawling in `robots.txt`, but catalogue pages currently
  return a Cloudflare challenge.
- **Salomon nepremičnine** currently returns a Cloudflare challenge.
- **remax.si** (without the hyphen) is not the RE/MAX agency site.

Apply the database migration before importing:

```bash
pnpm migrate:sql
pnpm ingest:listings -- --dry-run --sources=re-max,oglasnik --transaction-types=sale,rent --max-pages=1 --max-listings=5
pnpm ingest:listings -- --sources=re-max,oglasnik --transaction-types=sale,rent --max-pages=1 --max-listings=50
```

Keller Williams is included in the default source list. Because of its 30
second crawl delay, a first look is cheaper with an explicit cap:

```bash
pnpm ingest:listings -- --dry-run --sources=kw --transaction-types=sale --max-pages=1 --max-listings=2
```

`--dry-run` prints normalized ads and does not open the database. The
authenticated HTTP import is not a dry run:

```bash
curl -X POST http://localhost:3000/ingest/listings \
  -H "content-type: application/json" \
  -H "x-api-key: $AUTH_KEY" \
  -d '{"sources":["re-max","oglasnik"],"transactionTypes":["sale","rent"],"maxPages":1,"maxListings":50}'
```

Imports default to enabled sources, both sale and rent, one page, and 50 ads
per source and transaction type. Limits allow at most 100 pages and 2,000 ads
per catalogue. Downloads run sequentially with a per-source delay, timeouts,
and bounded retries. Results report successes/failures, saved/skipped counts,
location coverage, cross-source duplicates, and whether the catalogue was
complete. The CLI exits with a nonzero status if any catalogue fails; HTTP
callers should inspect each summary's `status`.

A stable `source:transactionType:sourceListingId` identifies each ad. Repeat
imports update it, preserve `firstSeenAt`, and refresh `lastSeenAt` and
`scrapedAt`. Ads that share a transaction, property type, rounded price, size,
and place (coordinates to about 100 metres, or the location text when no
coordinates exist) get the same `contentFingerprint`. The read API can hide
the extra copies with `dedupe=true`; the preferred source is the one with the
lower priority number. Ads without a price or a place are not grouped.
Each catalogue commits atomically. An interrupted, capped, empty, or ambiguously
parsed catalogue never deactivates unseen ads. Only a complete, nonempty import
without skipped entries can mark missing ads inactive. Failed downloads leave
that catalogue's prior inventory intact. Concurrent imports return HTTP 409.

### Five-minute refresh

The Hetzner VM refreshes listings every five minutes. `deploy/deploy.sh`
installs a cron entry for the deployment user that runs
`deploy/refresh-listings.sh`. The script executes
`node dist/listings/scheduled.js` inside the running API container and appends
the output to `/opt/property-scraper/listings-refresh.log`.

`.github/workflows/ingest-listings.yml` is a manual run of that same script
(`workflow_dispatch`), using the deployment SSH secrets:

- `HETZNER_VM_SSH_KEY`
- `HETZNER_VM_KNOWN_HOSTS`
- `HETZNER_VM_HOST`
- `HETZNER_VM_USER`

GitHub scheduled workflows are best-effort, so this refresh does not use a
GitHub Actions cron. No extra database secret is required. The container
already has `DATABASE_URL` from `/opt/property-scraper/.env`. The compose
project name must stay `property-scraper` and the API service name `api`.
The next production deploy reinstalls the cron entry. Host setup, logs, and
pausing the schedule are described in `DEPLOYMENT.md`.

The scheduled pass is an incremental refresh, not a full-market crawl:

- sources are `re-max` and `oglasnik` only
- one page and at most 25 ads per source and transaction type
- RE/MAX requests pause 1.5 seconds; this pass is a handful of requests
- Keller Williams is not included, because its 30 second crawl delay cannot
  finish inside five minutes. Run it separately, for example
  `pnpm ingest:listings -- --sources=kw --transaction-types=sale,rent --max-pages=1 --max-listings=10`
- the page is capped, so ads missing from that slice stay active

Locally, the same command is `pnpm ingest:listings:scheduled`. It needs
`DATABASE_URL` (and the listing migration). If another import holds the
database lock, the scheduled run logs a skip and exits successfully. A second
host run exits successfully when the refresh lock is already held. A failed
catalogue still exits nonzero. The host script stops a hung download after
four minutes so it does not pile onto the next slot.

```text
GET /listings/sources
GET /listings/sales
GET /listings/sales/{id}
GET /listings/rentals
GET /listings/rentals/{id}
GET /listings/map/tiles/sales/{z}/{x}/{y}.mvt
GET /listings/map/tiles/rentals/{z}/{x}/{y}.mvt
```

List pagination follows the existing `limit`/`cursor` convention (50 by default,
200 maximum). Filters include `source`, `propertyType`, `priceUnit`,
`priceMin`/`priceMax`, `areaMin`/`areaMax`, WGS84 `bbox`, and `dedupe=true`.
List routes default to `active=true`; use `active=false` for retired ads or
`active=all` for both.
Detail routes also retain inactive ads. Any price range requires `priceUnit`:

```text
/listings/sales?propertyType=house&priceUnit=total&priceMax=400000
/listings/rentals?priceUnit=month&priceMax=1500
```

Prices are asking prices. Rental periods absent from the source remain
`priceUnit=unknown` and will not match a monthly-price filter. Missing prices,
areas, or coordinates remain null. Coordinates carry `locationAccuracy`
(`exact`, `approximate`, or `unknown`); the seller's profile address is never
used as the property's address. Ads without coordinates remain in the read API
and are omitted from map tiles.

Map source-layers are **`listing_sales`** and **`listing_rentals`**, separate
from the existing GURS `sales` layer. Zooms 0–11 return clusters with
`cluster_count`; zoom 12 onward returns pins with `id`, `source`, `url`,
`asking_price`, `currency`, `price_unit`, `property_type`, and
`location_accuracy`. All tiles show active ads, are viewport-limited by
`ST_TileEnvelope`, and accept the list filters above except `active`, `cursor`,
and `limit`. Attach `x-api-key` as for the existing map API. Clients can style
sale and rental source-layers separately and use an ad's `id` for its detail
endpoint.

## Docker

Run the API and PostGIS 17 with:

```bash
docker compose up --build
```

Kyrage tracks ordinary columns and tables; versioned raw SQL manages PostGIS,
`pg_trgm`, geometry columns, and GiST indexes. SQL migration 006 bootstraps
advertisement storage, and 007 adds `scraped_at`, `content_fingerprint`, and
`duplicate_of`, so the production deployment can apply them without the
development-only Kyrage CLI:

```bash
docker compose exec api pnpm migrate:generate
docker compose exec api pnpm migrate:apply
```

`migrate:apply` applies Kyrage first and then any unapplied SQL files under
`migrations/sql`. To apply only the SQL migrations, run
`pnpm migrate:sql`.

The `Dockerfile` also contains a minimal `production` target:

```bash
docker build --target production -t property-scraper .
```
