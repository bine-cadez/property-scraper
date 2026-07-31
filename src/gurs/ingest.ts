import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Pool } from "pg";

import { parseCsv, type CsvRecord } from "./csv.js";
import { refreshMapTables } from "./map-refresh.js";

type JsonObject = Record<string, unknown>;

type GeoJsonFeature = {
  id?: string;
  geometry?: unknown;
  properties: JsonObject;
};

type FeatureCollection = {
  features: GeoJsonFeature[];
  numberMatched?: number;
  numberReturned?: number;
};

export type ImportSummary = {
  source: string;
  rows: number;
  skippedRows?: number;
  skipReason?: string;
};

export type IngestProgress = {
  phase: "anchor" | "fetch" | "resolve" | "write" | "replace" | "complete";
  source: string;
  message: string;
  details: JsonObject;
};

type Queryable = {
  query(text: string, values?: unknown[]): Promise<unknown>;
};

type FetchCache = {
  database: Queryable;
  runKey: string;
};

type FetchResult<T> = {
  data: T;
  cached: boolean;
};

type SqlValueType = "integer" | "numeric" | "text";
export type ProgressReporter = (progress: IngestProgress) => void;

export const DEFAULT_LIVE_SAMPLE_SIZE = 2;
export const MAX_LIVE_SAMPLE_SIZE = 10_000;
export const DEFAULT_TRANSACTION_YEAR = 2025;

const FETCH_BATCH_SIZE = 1_000;
const CQL_BATCH_SIZE = 40;
const WRITE_BATCH_SIZE = 200;
const FETCH_MAX_ATTEMPTS = 7;
const FETCH_RETRY_BASE_DELAY_MS = 1_000;
const FETCH_RETRY_MAX_DELAY_MS = 30_000;
const RETRIEVAL_DATE = new Date().toISOString().slice(0, 10);
const LICENCE = "CC BY 4.0";
const KN_BASE =
  "https://ipi.eprostor.gov.si/wfs-si-gurs-kn/ogc/features/collections";
const EV_BASE =
  "https://ipi.eprostor.gov.si/wfs-si-gurs-ev/ogc/features/collections";
const FETCH_TIMEOUT_MS = 5 * 60_000;
const FETCH_CACHE_MAX_AGE = "7 days";

const KN_COLLECTIONS = [
  "PARCELE",
  "STAVBE",
  "DELI_STAVB",
  "STAVBE_PARCELE",
  "KATASTRSKE_OBCINE",
  "NASLOVI_HS",
] as const;

const EV_COLLECTIONS = [
  "PARCELA",
  "PARC_ENOTA",
  "STAVBA",
  "DEL_STAVBE",
  "DEL_STAVBE_ENOTA",
] as const;

const LIVE_DATA_TABLES = [
  "gurs_ev_building_part_units",
  "gurs_ev_parcel_units",
  "gurs_kn_addresses",
  "gurs_kn_cadastral_municipalities",
  "gurs_kn_building_parcels",
  "gurs_kn_building_parts",
  "gurs_kn_buildings",
  "gurs_kn_parcels",
] as const;

export function validateLiveSampleSize(value: unknown): number {
  const sampleSize =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  if (
    !Number.isInteger(sampleSize) ||
    sampleSize < 1 ||
    sampleSize > MAX_LIVE_SAMPLE_SIZE
  ) {
    throw new Error(
      `sampleSize must be an integer between 1 and ${MAX_LIVE_SAMPLE_SIZE}`,
    );
  }

  return sampleSize;
}

export function validateTransactionYear(value: unknown): number {
  const year =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  if (!Number.isInteger(year) || year < 2007 || year > 2100) {
    throw new Error("transactionYear must be an integer between 2007 and 2100");
  }

  return year;
}

function addSummary(
  summaries: ImportSummary[],
  summary: ImportSummary,
  report?: ProgressReporter,
): void {
  summaries.push(summary);
  report?.({
    phase: "complete",
    source: summary.source,
    message: `Completed ${summary.source}`,
    details: {
      rows: summary.rows,
      skippedRows: summary.skippedRows ?? 0,
      skipReason: summary.skipReason ?? null,
    },
  });
}

function filterRequiredRows<T extends JsonObject>(
  rows: T[],
  requiredColumns: Array<keyof T>,
): { validRows: T[]; skippedRows: number } {
  const validRows = rows.filter((row) =>
    requiredColumns.every(
      (column) =>
        row[column] !== null &&
        row[column] !== undefined &&
        row[column] !== "",
    ),
  );

  return {
    validRows,
    skippedRows: rows.length - validRows.length,
  };
}

function text(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return String(value);
}

function numberValue(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function slovenianDate(value: unknown): string | null {
  const raw = text(value);

  if (!raw) {
    return null;
  }

  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);

  if (!match) {
    throw new Error(`Unexpected Slovenian date: ${raw}`);
  }

  return `${match[3]}-${match[2]}-${match[1]}`;
}

function sourceKey(dataset: string): string {
  return `${dataset.toLowerCase().replaceAll("_", "-")}-${RETRIEVAL_DATE}`;
}

function attribution(dataset: string): string {
  return `Geodetska uprava Republike Slovenije, ${dataset}, ${RETRIEVAL_DATE}`;
}

class FetchHttpError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function requestHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function retryDelay(attempt: number, requestedDelay?: number): number {
  return Math.min(
    requestedDelay ?? FETCH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    FETCH_RETRY_MAX_DELAY_MS,
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cachedResponse<T>(
  cache: FetchCache,
  url: string,
): Promise<T | undefined> {
  const result = (await cache.database.query(
    `
      SELECT response
      FROM public.gurs_ingest_fetch_cache
      WHERE run_key = $1 AND request_hash = $2
    `,
    [cache.runKey, requestHash(url)],
  )) as { rows?: Array<{ response: T }> };
  return result.rows?.[0]?.response;
}

async function cacheResponse<T>(
  cache: FetchCache,
  url: string,
  data: T,
): Promise<void> {
  await cache.database.query(
    `
      INSERT INTO public.gurs_ingest_fetch_cache (
        run_key, request_hash, request_url, response
      )
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (run_key, request_hash) DO UPDATE SET
        request_url = EXCLUDED.request_url,
        response = EXCLUDED.response,
        fetched_at = CURRENT_TIMESTAMP
    `,
    [cache.runKey, requestHash(url), url, JSON.stringify(data)],
  );
}

async function fetchJson<T>(
  input: URL | string,
  cache?: FetchCache,
  report?: ProgressReporter,
): Promise<FetchResult<T>> {
  const url = String(input);
  if (cache) {
    const data = await cachedResponse<T>(cache, url);
    if (data !== undefined) return { data, cached: true };
  }

  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json, application/geo+json",
          "user-agent": "property-scraper GURS source validator",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const responseBody = (await response.text()).trim().slice(0, 1_000);
        throw new FetchHttpError(
          [
            `${response.status} ${response.statusText} returned by ${response.url}`,
            responseBody,
          ]
            .filter(Boolean)
            .join(": "),
          response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500,
          retryAfterMilliseconds(response),
        );
      }

      const data = (await response.json()) as T;
      if (cache) await cacheResponse(cache, url, data);
      return { data, cached: false };
    } catch (error) {
      const canRetry =
        !(error instanceof FetchHttpError) || error.retryable;
      if (!canRetry || attempt === FETCH_MAX_ATTEMPTS) throw error;

      const delayMs = retryDelay(
        attempt,
        error instanceof FetchHttpError ? error.retryAfterMs : undefined,
      );
      report?.({
        phase: "fetch",
        source: new URL(url).pathname.split("/").at(-2) ?? "GURS",
        message: `Fetch failed; retrying request ${attempt + 1}/${FETCH_MAX_ATTEMPTS}`,
        details: {
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      await wait(delayMs);
    }
  }

  throw new Error("Unreachable fetch retry state");
}

async function fetchCollection(
  baseUrl: string,
  collection: string,
  sampleSize: number,
  report?: ProgressReporter,
  cache?: FetchCache,
): Promise<FeatureCollection> {
  const features: GeoJsonFeature[] = [];
  let numberMatched: number | undefined;
  let batch = 0;

  while (
    features.length < sampleSize &&
    (numberMatched === undefined || features.length < numberMatched)
  ) {
    const limit = Math.min(FETCH_BATCH_SIZE, sampleSize - features.length);
    const url = new URL(`${baseUrl}/${collection}/items`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("startIndex", String(features.length));

    const result = await fetchJson<FeatureCollection>(url, cache, report);
    const data = result.data;
    numberMatched = data.numberMatched ?? numberMatched;
    features.push(...data.features);
    batch += 1;

    report?.({
      phase: "fetch",
      source: collection,
      message: result.cached
        ? `Reused checkpointed batch ${batch} for ${collection}`
        : `Fetched batch ${batch} for ${collection}`,
      details: {
        batch,
        batchRows: data.features.length,
        fetchedRows: features.length,
        requestedRows: sampleSize,
        numberMatched: numberMatched ?? null,
        cacheHit: result.cached,
      },
    });

    if (data.features.length < limit) {
      break;
    }
  }

  return {
    features,
    numberReturned: features.length,
    ...(numberMatched === undefined ? {} : { numberMatched }),
  };
}

type CqlScalar = string | number;
type CqlRow = Record<string, CqlScalar>;

function cqlValue(value: CqlScalar): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("CQL numeric values must be finite");
    }
    return String(value);
  }

  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Builds bounded, caller-independent CQL predicates. Field names are supplied
 * by the importer, never by API callers.
 */
export function buildCqlPredicateBatches(
  rows: CqlRow[],
  fields: string[],
  batchSize = CQL_BATCH_SIZE,
): string[] {
  if (
    fields.length === 0 ||
    fields.some((field) => !/^[A-Z][A-Z0-9_]*$/.test(field))
  ) {
    throw new Error("Unsafe or empty CQL field list");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("CQL batch size must be a positive integer");
  }

  const uniqueRows = [
    ...new Map(
      rows.map((row) => [
        fields.map((field) => String(row[field])).join("\u0000"),
        row,
      ]),
    ).values(),
  ];
  const predicates: string[] = [];

  for (let offset = 0; offset < uniqueRows.length; offset += batchSize) {
    const batch = uniqueRows.slice(offset, offset + batchSize);
    predicates.push(
      batch
        .map((row) => {
          const terms = fields.map((field) => {
            const value = row[field];
            if (value === undefined) {
              throw new Error(`Missing CQL value for ${field}`);
            }
            return `${field} = ${cqlValue(value)}`;
          });
          return `(${terms.join(" AND ")})`;
        })
        .join(" OR "),
    );
  }

  return predicates;
}

function featureIdentity(feature: GeoJsonFeature): string {
  if (feature.id) return feature.id;

  const properties = feature.properties;
  const naturalId =
    properties.EID_DEL_STAVBE ??
    properties.EID_STAVBA_PARCELA ??
    properties.EID_HISNA_STEVILKA ??
    properties.EID_KATASTRSKA_OBCINA ??
    properties.EID_STAVBA ??
    properties.EID_PARCELA ??
    properties.ID_PARC_ENOTA;
  if (naturalId !== undefined && naturalId !== null) {
    const model = properties.ID_MODEL ?? "";
    return `${String(naturalId)}:${String(model)}`;
  }
  return JSON.stringify(properties);
}

async function fetchCollectionPredicates(
  baseUrl: string,
  collection: string,
  predicates: string[],
  report?: ProgressReporter,
  cache?: FetchCache,
): Promise<FeatureCollection> {
  const deduplicated = new Map<string, GeoJsonFeature>();
  let totalMatched = 0;

  for (const [predicateIndex, predicate] of predicates.entries()) {
    let startIndex = 0;
    let numberMatched: number | undefined;
    let page = 0;

    do {
      const url = new URL(`${baseUrl}/${collection}/items`);
      url.searchParams.set("limit", String(FETCH_BATCH_SIZE));
      url.searchParams.set("startIndex", String(startIndex));
      url.searchParams.set("filter-lang", "cql-text");
      url.searchParams.set("filter", predicate);
      const result = await fetchJson<FeatureCollection>(url, cache, report);
      const data = result.data;
      numberMatched = data.numberMatched ?? numberMatched;
      totalMatched += page === 0 ? (numberMatched ?? data.features.length) : 0;
      for (const feature of data.features) {
        deduplicated.set(featureIdentity(feature), feature);
      }
      startIndex += data.features.length;
      page += 1;

      report?.({
        phase: "fetch",
        source: collection,
        message: result.cached
          ? `Reused checkpoint for CQL request ${predicateIndex + 1}/${predicates.length}, page ${page}`
          : `Fetched CQL request ${predicateIndex + 1}/${predicates.length}, page ${page}`,
        details: {
          requestBatch: predicateIndex + 1,
          requestBatches: predicates.length,
          page,
          batchRows: data.features.length,
          deduplicatedRows: deduplicated.size,
          numberMatched: numberMatched ?? null,
          cacheHit: result.cached,
        },
      });

      if (data.features.length === 0) break;
    } while (
      numberMatched === undefined
        ? startIndex % FETCH_BATCH_SIZE === 0
        : startIndex < numberMatched
    );
  }

  return {
    features: [...deduplicated.values()],
    numberMatched: totalMatched,
    numberReturned: deduplicated.size,
  };
}

function predicatesForIds(field: string, ids: CqlScalar[]): string[] {
  return buildCqlPredicateBatches(
    ids.map((id) => ({ [field]: id })),
    [field],
  );
}

function combineCollections(
  ...collections: FeatureCollection[]
): FeatureCollection {
  const features = new Map<string, GeoJsonFeature>();
  for (const collection of collections) {
    for (const feature of collection.features) {
      features.set(featureIdentity(feature), feature);
    }
  }
  return {
    features: [...features.values()],
    numberReturned: features.size,
    numberMatched: features.size,
  };
}

type AnchorTransaction = {
  id_posla: string;
  contract_date: string | null;
};

type AnchorBuildingPart = {
  record_key: string;
  id_posla: string;
  ko_id: number | null;
  building_number: number | null;
  part_number: number | null;
};

type AnchorLand = {
  record_key: string;
  id_posla: string;
  ko_id: number | null;
  parcel_number: string | null;
};

type AnchorSet = {
  transactions: AnchorTransaction[];
  buildingParts: AnchorBuildingPart[];
  land: AnchorLand[];
};

type QueryRows<T> = { rows: T[] };

function fetchCacheRunKey(
  anchors: AnchorSet,
  sampleSize: number,
  transactionYear: number,
): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        sampleSize,
        transactionYear,
        transactions: anchors.transactions,
        buildingParts: anchors.buildingParts,
        land: anchors.land,
      }),
    )
    .digest("hex");
  return `v1:${fingerprint}`;
}

async function prepareFetchCache(
  database: Queryable,
  anchors: AnchorSet,
  sampleSize: number,
  transactionYear: number,
  report?: ProgressReporter,
): Promise<FetchCache> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS public.gurs_ingest_fetch_cache (
      run_key text NOT NULL,
      request_hash text NOT NULL,
      request_url text NOT NULL,
      response jsonb NOT NULL,
      fetched_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (run_key, request_hash)
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS gurs_ingest_fetch_cache_fetched_at_idx
    ON public.gurs_ingest_fetch_cache (fetched_at)
  `);
  await database.query(
    `
      DELETE FROM public.gurs_ingest_fetch_cache
      WHERE fetched_at < CURRENT_TIMESTAMP - $1::interval
    `,
    [FETCH_CACHE_MAX_AGE],
  );

  const runKey = fetchCacheRunKey(anchors, sampleSize, transactionYear);
  const existing = (await database.query(
    `
      SELECT count(*)::int AS count
      FROM public.gurs_ingest_fetch_cache
      WHERE run_key = $1
    `,
    [runKey],
  )) as { rows?: Array<{ count: number }> };
  report?.({
    phase: "fetch",
    source: "checkpoint cache",
    message: "Prepared persistent fetch checkpoints",
    details: {
      reusableResponses: Number(existing.rows?.[0]?.count ?? 0),
      retention: FETCH_CACHE_MAX_AGE,
    },
  });
  return { database, runKey };
}

async function clearFetchCache(
  database: Queryable,
  cache: FetchCache,
): Promise<void> {
  await database.query(
    "DELETE FROM public.gurs_ingest_fetch_cache WHERE run_key = $1",
    [cache.runKey],
  );
}

async function loadAnchorSet(
  pool: Pool,
  sampleSize: number,
  transactionYear: number,
  report?: ProgressReporter,
): Promise<AnchorSet | null> {
  // Some unit-test query doubles only implement connect(). Retain a narrow
  // fallback for those doubles; real pg.Pool instances always expose query().
  if (typeof pool.query !== "function") {
    return null;
  }

  const transactionResult = (await pool.query(
    `
      SELECT id_posla::text, contract_date::text
      FROM gurs_etn_transactions
      WHERE year = $1
      ORDER BY contract_date DESC NULLS LAST, id_posla DESC
      LIMIT $2
    `,
    [transactionYear, sampleSize],
  )) as QueryRows<AnchorTransaction>;
  const transactions = transactionResult.rows ?? [];

  if (transactions.length === 0) {
    throw new Error(
      `No ETN transactions found for transaction year ${transactionYear}`,
    );
  }

  const transactionIds = transactions.map(({ id_posla }) => id_posla);
  const [buildingPartResult, landResult] = (await Promise.all([
    pool.query(
      `
        SELECT
          record_key, id_posla::text, ko_id, building_number, part_number
        FROM gurs_etn_building_parts
        WHERE id_posla = ANY($1::bigint[])
        ORDER BY id_posla DESC, record_key
      `,
      [transactionIds],
    ),
    pool.query(
      `
        SELECT record_key, id_posla::text, ko_id, parcel_number
        FROM gurs_etn_land
        WHERE id_posla = ANY($1::bigint[])
        ORDER BY id_posla DESC, record_key
      `,
      [transactionIds],
    ),
  ])) as [QueryRows<AnchorBuildingPart>, QueryRows<AnchorLand>];

  const anchors = {
    transactions,
    buildingParts: buildingPartResult.rows ?? [],
    land: landResult.rows ?? [],
  };
  report?.({
    phase: "anchor",
    source: "ETN",
    message: `Selected ${transactions.length} ETN transaction anchors`,
    details: {
      transactionYear,
      requestedTransactions: sampleSize,
      transactions: transactions.length,
      buildingPartItems: anchors.buildingParts.length,
      landItems: anchors.land.length,
    },
  });
  return anchors;
}

function stringValues(
  features: GeoJsonFeature[],
  property: string,
): string[] {
  return [
    ...new Set(
      features
        .map(({ properties }) => text(properties[property]))
        .filter((value): value is string => value !== null),
    ),
  ];
}

type Coverage = {
  anchorTransactions: number;
  buildingPartItems: number;
  resolvedBuildingPartItems: number;
  unresolvedBuildingPartItems: string[];
  landItems: number;
  resolvedLandItems: number;
  unresolvedLandItems: string[];
};

async function fetchCoherentGraph(
  anchors: AnchorSet,
  report?: ProgressReporter,
  cache?: FetchCache,
): Promise<{
  knResults: Map<string, FeatureCollection>;
  evResults: Map<string, FeatureCollection>;
  coverage: Coverage;
}> {
  const partKeys = anchors.buildingParts
    .filter(
      (item) =>
        item.ko_id !== null &&
        item.building_number !== null &&
        item.part_number !== null,
    )
    .map((item) => ({
      KO_ID: item.ko_id!,
      ST_STAVBE: item.building_number!,
      ST_DELA_STAVBE: item.part_number!,
    }));
  const parcelKeys = anchors.land
    .filter((item) => item.ko_id !== null && item.parcel_number !== null)
    .map((item) => ({
      KO_ID: item.ko_id!,
      ST_PARCELE: item.parcel_number!,
    }));

  const [soldParts, soldParcels] = await Promise.all([
    fetchCollectionPredicates(
      KN_BASE,
      "DELI_STAVB",
      buildCqlPredicateBatches(partKeys, [
        "KO_ID",
        "ST_STAVBE",
        "ST_DELA_STAVBE",
      ]),
      report,
      cache,
    ),
    fetchCollectionPredicates(
      KN_BASE,
      "PARCELE",
      buildCqlPredicateBatches(parcelKeys, ["KO_ID", "ST_PARCELE"]),
      report,
      cache,
    ),
  ]);

  const soldPartNaturalKeys = new Set(
    soldParts.features.map(({ properties: p }) =>
      [p.KO_ID, p.ST_STAVBE, p.ST_DELA_STAVBE].map(String).join(":"),
    ),
  );
  const soldParcelNaturalKeys = new Set(
    soldParcels.features.map(({ properties: p }) =>
      [p.KO_ID, p.ST_PARCELE].map(String).join(":"),
    ),
  );
  const unresolvedBuildingPartItems = anchors.buildingParts
    .filter(
      (item) =>
        item.ko_id === null ||
        item.building_number === null ||
        item.part_number === null ||
        !soldPartNaturalKeys.has(
          `${item.ko_id}:${item.building_number}:${item.part_number}`,
        ),
    )
    .map(({ record_key }) => record_key);
  const unresolvedLandItems = anchors.land
    .filter(
      (item) =>
        item.ko_id === null ||
        item.parcel_number === null ||
        !soldParcelNaturalKeys.has(`${item.ko_id}:${item.parcel_number}`),
    )
    .map(({ record_key }) => record_key);

  const soldParcelIds = stringValues(soldParcels.features, "EID_PARCELA");
  const landBuildingRelationships =
    soldParcelIds.length === 0
      ? { features: [] }
      : await fetchCollectionPredicates(
          KN_BASE,
          "STAVBE_PARCELE",
          predicatesForIds("EID_PARCELA", soldParcelIds),
          report,
          cache,
        );
  const buildingIds = [
    ...new Set([
      ...stringValues(soldParts.features, "EID_STAVBA"),
      ...stringValues(landBuildingRelationships.features, "EID_STAVBA"),
    ]),
  ];

  const [buildings, allParts, addresses, buildingRelationships] =
    buildingIds.length === 0
      ? [
          { features: [] },
          { features: [] },
          { features: [] },
          { features: [] },
        ]
      : await Promise.all([
          fetchCollectionPredicates(
            KN_BASE,
            "STAVBE",
            predicatesForIds("EID_STAVBA", buildingIds),
            report,
            cache,
          ),
          fetchCollectionPredicates(
            KN_BASE,
            "DELI_STAVB",
            predicatesForIds("EID_STAVBA", buildingIds),
            report,
            cache,
          ),
          fetchCollectionPredicates(
            KN_BASE,
            "NASLOVI_HS",
            predicatesForIds("EID_STAVBA", buildingIds),
            report,
            cache,
          ),
          fetchCollectionPredicates(
            KN_BASE,
            "STAVBE_PARCELE",
            predicatesForIds("EID_STAVBA", buildingIds),
            report,
            cache,
          ),
        ]);
  const relationships = combineCollections(
    landBuildingRelationships,
    buildingRelationships,
  );
  const parcelIds = [
    ...new Set([
      ...soldParcelIds,
      ...stringValues(relationships.features, "EID_PARCELA"),
    ]),
  ];
  const relatedParcels =
    parcelIds.length === 0
      ? { features: [] }
      : await fetchCollectionPredicates(
          KN_BASE,
          "PARCELE",
          predicatesForIds("EID_PARCELA", parcelIds),
          report,
          cache,
        );
  const parcels = combineCollections(soldParcels, relatedParcels);
  const parts = combineCollections(soldParts, allParts);
  const municipalityIds = [
    ...new Set(
      [...buildings.features, ...parts.features, ...parcels.features]
        .map(({ properties }) => integer(properties.KO_ID))
        .filter((value): value is number => value !== null),
    ),
  ];
  const municipalities =
    municipalityIds.length === 0
      ? { features: [] }
      : await fetchCollectionPredicates(
          KN_BASE,
          "KATASTRSKE_OBCINE",
          predicatesForIds("KO_ID", municipalityIds),
          report,
          cache,
        );
  const resolvedBuildingIds = stringValues(buildings.features, "EID_STAVBA");
  const resolvedPartIds = stringValues(parts.features, "EID_DEL_STAVBE");
  const resolvedParcelIds = stringValues(parcels.features, "EID_PARCELA");

  const empty = (): FeatureCollection => ({ features: [] });
  const [
    evParcels,
    evParcelUnits,
    evBuildings,
    evParts,
    evPartUnits,
  ] = await Promise.all([
    resolvedParcelIds.length
      ? fetchCollectionPredicates(
          EV_BASE,
          "PARCELA",
          predicatesForIds("EID_PARCELA", resolvedParcelIds),
          report,
          cache,
        )
      : empty(),
    resolvedParcelIds.length
      ? fetchCollectionPredicates(
          EV_BASE,
          "PARC_ENOTA",
          predicatesForIds("EID_PARCELA", resolvedParcelIds),
          report,
          cache,
        )
      : empty(),
    resolvedBuildingIds.length
      ? fetchCollectionPredicates(
          EV_BASE,
          "STAVBA",
          predicatesForIds("EID_STAVBA", resolvedBuildingIds),
          report,
          cache,
        )
      : empty(),
    resolvedPartIds.length
      ? fetchCollectionPredicates(
          EV_BASE,
          "DEL_STAVBE",
          predicatesForIds("EID_DEL_STAVBE", resolvedPartIds),
          report,
          cache,
        )
      : empty(),
    resolvedPartIds.length
      ? fetchCollectionPredicates(
          EV_BASE,
          "DEL_STAVBE_ENOTA",
          predicatesForIds("EID_DEL_STAVBE", resolvedPartIds),
          report,
          cache,
        )
      : empty(),
  ]);

  const knResults = new Map<string, FeatureCollection>([
    ["PARCELE", parcels],
    ["STAVBE", buildings],
    ["DELI_STAVB", parts],
    ["STAVBE_PARCELE", relationships],
    ["KATASTRSKE_OBCINE", municipalities],
    ["NASLOVI_HS", addresses],
  ]);
  const evResults = new Map<string, FeatureCollection>([
    ["PARCELA", evParcels],
    ["PARC_ENOTA", evParcelUnits],
    ["STAVBA", evBuildings],
    ["DEL_STAVBE", evParts],
    ["DEL_STAVBE_ENOTA", evPartUnits],
  ]);
  const coverage: Coverage = {
    anchorTransactions: anchors.transactions.length,
    buildingPartItems: anchors.buildingParts.length,
    resolvedBuildingPartItems:
      anchors.buildingParts.length - unresolvedBuildingPartItems.length,
    unresolvedBuildingPartItems,
    landItems: anchors.land.length,
    resolvedLandItems: anchors.land.length - unresolvedLandItems.length,
    unresolvedLandItems,
  };

  report?.({
    phase: "resolve",
    source: "GURS property graph",
    message: "Resolved ETN items and expanded the one-hop property graph",
    details: {
      ...coverage,
      unresolvedBuildingPartItems: unresolvedBuildingPartItems.length,
      unresolvedLandItems: unresolvedLandItems.length,
      buildings: buildings.features.length,
      buildingParts: parts.features.length,
      addresses: addresses.features.length,
      parcels: parcels.features.length,
      buildingParcelRelationships: relationships.features.length,
      cadastralMunicipalities: municipalities.features.length,
    },
  });

  return { knResults, evResults, coverage };
}

function checkedSqlIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}

async function upsertRows(
  pool: Queryable,
  table: string,
  conflictColumns: string[],
  rows: JsonObject[],
  batchSize = WRITE_BATCH_SIZE,
  report?: ProgressReporter,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const columns = Object.keys(rows[0] ?? {});
  const quotedTable = checkedSqlIdentifier(table);
  const quotedColumns = columns.map(checkedSqlIdentifier);
  const quotedConflictColumns = conflictColumns.map(checkedSqlIdentifier);
  const updateColumns = columns.filter(
    (column) => !conflictColumns.includes(column),
  );
  const updateSql = updateColumns
    .map(
      (column) =>
        `${checkedSqlIdentifier(column)} = EXCLUDED.${checkedSqlIdentifier(column)}`,
    )
    .join(", ");
  const changedSql = [
    `(${updateColumns
      .map((column) => `target.${checkedSqlIdentifier(column)}`)
      .join(", ")})`,
    "IS DISTINCT FROM",
    `(${updateColumns
      .map((column) => `EXCLUDED.${checkedSqlIdentifier(column)}`)
      .join(", ")})`,
  ].join(" ");

  const totalBatches = Math.ceil(rows.length / batchSize);

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const batchNumber = Math.floor(offset / batchSize) + 1;
    const values: unknown[] = [];
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = columns.map((column, columnIndex) => {
        values.push(row[column] ?? null);
        return `$${rowIndex * columns.length + columnIndex + 1}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    await pool.query(
      [
        `INSERT INTO ${quotedTable} AS target (${quotedColumns.join(", ")})`,
        `VALUES ${tuples.join(", ")}`,
        `ON CONFLICT (${quotedConflictColumns.join(", ")}) DO UPDATE SET ${updateSql}`,
        `WHERE ${changedSql}`,
      ].join("\n"),
      values,
    );

    if (
      batchNumber === 1 ||
      batchNumber === totalBatches ||
      batchNumber % 10 === 0
    ) {
      report?.({
        phase: "write",
        source: table,
        message: `Staged batch ${batchNumber}/${totalBatches} for ${table}`,
        details: {
          batch: batchNumber,
          totalBatches,
          batchRows: batch.length,
          writtenRows: offset + batch.length,
          totalRows: rows.length,
        },
      });
    }
  }
}

async function enrichRowsByKey(
  pool: Queryable,
  table: string,
  keyColumn: string,
  rows: JsonObject[],
  columnTypes: Record<string, SqlValueType>,
  report?: ProgressReporter,
  batchSize = WRITE_BATCH_SIZE,
): Promise<void> {
  const quotedTable = checkedSqlIdentifier(table);
  const quotedKey = checkedSqlIdentifier(keyColumn);
  const columns = Object.keys(rows[0] ?? {}).filter(
    (column) => column !== keyColumn,
  );
  const incomingColumns = [
    `${quotedKey} text`,
    ...columns.map((column) => {
      const columnType = columnTypes[column];

      if (!columnType) {
        throw new Error(`Missing SQL type for ${table}.${column}`);
      }

      return `${checkedSqlIdentifier(column)} ${columnType}`;
    }),
  ];
  const assignments = columns.map((column) => {
    const quotedColumn = checkedSqlIdentifier(column);

    if (column.endsWith("_source_key")) {
      return `${quotedColumn} = incoming.${quotedColumn}`;
    }

    return `${quotedColumn} = COALESCE(target.${quotedColumn}, incoming.${quotedColumn})`;
  });
  const totalBatches = Math.ceil(rows.length / batchSize);

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const batchNumber = Math.floor(offset / batchSize) + 1;

    await pool.query(
      [
        `UPDATE ${quotedTable} AS target`,
        `SET ${assignments.join(", ")}`,
        `FROM jsonb_to_recordset($1::jsonb) AS incoming (${incomingColumns.join(", ")})`,
        `WHERE target.${quotedKey} = incoming.${quotedKey}`,
      ].join("\n"),
      [JSON.stringify(batch)],
    );

    if (
      batchNumber === 1 ||
      batchNumber === totalBatches ||
      batchNumber % 10 === 0
    ) {
      report?.({
        phase: "write",
        source: table,
        message: `Staged enrichment batch ${batchNumber}/${totalBatches} for ${table}`,
        details: {
          batch: batchNumber,
          totalBatches,
          batchRows: batch.length,
          processedRows: offset + batch.length,
          totalRows: rows.length,
        },
      });
    }
  }
}

function buildFullAddress(properties: JsonObject): string | null {
  const streetOrSettlement =
    text(properties.ULICA_NAZIV) ?? text(properties.NASELJE_NAZIV);
  const houseNumber = [
    text(properties.HS_STEVILKA),
    text(properties.HS_DODATEK),
  ]
    .filter(Boolean)
    .join("");
  const addressLine = [streetOrSettlement, houseNumber]
    .filter(Boolean)
    .join(" ");
  const postalLine = [
    text(properties.POSTNI_OKOLIS_SIFRA),
    text(properties.POSTNI_OKOLIS_NAZIV),
  ]
    .filter(Boolean)
    .join(" ");
  const fullAddress = [addressLine, postalLine].filter(Boolean).join(", ");
  return fullAddress || null;
}

async function recordSource(
  pool: Queryable,
  input: {
    datasetName: string;
    sourceUrl: string;
    sourceKey: string;
    referenceDate?: string | null;
    updateFrequency?: string | null;
    metadata: JsonObject;
  },
): Promise<void> {
  await upsertRows(pool, "gurs_source_retrievals", ["source_key"], [
    {
      source_key: input.sourceKey,
      dataset_name: input.datasetName,
      source_url: input.sourceUrl,
      retrieved_at: new Date().toISOString(),
      reference_date: input.referenceDate ?? null,
      licence: LICENCE,
      attribution: attribution(input.datasetName),
      http_status: 200,
      nationwide: true,
      update_frequency: input.updateFrequency ?? null,
      metadata: input.metadata,
    },
  ]);
}

async function ingestKn(
  pool: Queryable,
  collections: Map<string, FeatureCollection>,
  report?: ProgressReporter,
): Promise<ImportSummary[]> {
  const summaries: ImportSummary[] = [];

  for (const collection of KN_COLLECTIONS) {
    const data = collections.get(collection);
    if (!data) throw new Error(`Missing KN collection ${collection}`);

    await recordSource(pool, {
      datasetName: `Kataster nepremičnin – ${collection}`,
      sourceUrl: `${KN_BASE}/${collection}/items`,
      sourceKey: sourceKey(`kn-${collection}`),
      updateFrequency: "live service; source changes are reflected continuously",
      metadata: {
        service: "OGC API Features",
        collection,
        numberMatched: data.numberMatched ?? null,
        importedSampleRows: data.features.length,
        sourceCrs: "EPSG:3794",
        responseCrs: "OGC:CRS84",
      },
    });
  }

  const parcels = collections.get("PARCELE")!.features.map((feature) => {
    const p = feature.properties;
    return {
      eid_parcela: text(p.EID_PARCELA),
      ko_id: integer(p.KO_ID),
      parcel_number: text(p.ST_PARCELE),
      area: numberValue(p.POVRSINA),
      centroid_e: numberValue(p.E_CEN),
      centroid_n: numberValue(p.N_CEN),
      geometry: feature.geometry ?? null,
      administrative_status_code: integer(p.UPRAVNI_STATUSI_SIFRA),
      administrative_status_name: text(p.UPRAVNI_STATUSI_NAZIV_SL),
      land_rating: integer(p.BONITETA),
      source_updated_at: text(p.DATUM_SYS),
      source_key: sourceKey("kn-PARCELE"),
    };
  });
  await upsertRows(
    pool,
    "gurs_kn_parcels",
    ["eid_parcela"],
    parcels,
    WRITE_BATCH_SIZE,
    report,
  );
  addSummary(
    summaries,
    { source: "KN PARCELE sample", rows: parcels.length },
    report,
  );

  const buildings = collections.get("STAVBE")!.features.map((feature) => {
    const p = feature.properties;
    return {
      eid_stavba: text(p.EID_STAVBA),
      ko_id: integer(p.KO_ID),
      building_number: integer(p.ST_STAVBE),
      floor_count: integer(p.STEVILO_ETAZ),
      apartment_count: integer(p.STEVILO_STANOVANJ),
      business_premises_count: integer(p.STEVILO_POSLOVNIH_PROSTOROV),
      gross_floor_area: numberValue(p.BRUTO_TLORISNA_POVRSINA),
      construction_year: integer(p.LETO_IZGRADNJE),
      facade_renovation_year: integer(p.LETO_OBNOVE_FASADE),
      roof_renovation_year: integer(p.LETO_OBNOVE_STREHE),
      building_type_code: integer(p.TIPI_STAVB_SIFRA ?? p.TIP_STAVBE_ID),
      building_type_name: text(p.TIPI_STAVB_NAZIV_SL),
      construction_type_code: integer(
        p.NOSILNE_KONSTRUKCIJE_SIFRA ?? p.NOSILNA_KONSTRUKCIJA_ID,
      ),
      construction_type_name: text(p.NOSILNE_KONSTRUKCIJE_NAZIV_SL),
      electricity_code: integer(p.ELEKTRIKA_SIFRA ?? p.ELEKTRIKA),
      gas_code: integer(p.PLIN_SIFRA ?? p.PLIN),
      water_code: integer(p.VODOVOD_SIFRA ?? p.VODOVOD),
      sewer_code: integer(p.KANALIZACIJA_SIFRA ?? p.KANALIZACIJA),
      centroid_e: numberValue(p.E_CEN),
      centroid_n: numberValue(p.N_CEN),
      footprint_geometry:
        p.OBRIS_GEOM ??
        p.NADZEMNI_GEOM ??
        p.TLORIS_GEOM ??
        feature.geometry ??
        null,
      source_updated_at: text(p.DATUM_SYS),
      source_key: sourceKey("kn-STAVBE"),
    };
  });
  await upsertRows(
    pool,
    "gurs_kn_buildings",
    ["eid_stavba"],
    buildings,
    WRITE_BATCH_SIZE,
    report,
  );
  addSummary(
    summaries,
    { source: "KN STAVBE sample", rows: buildings.length },
    report,
  );

  const buildingParts = collections
    .get("DELI_STAVB")!
    .features.map((feature) => {
      const p = feature.properties;
      return {
        eid_del_stavbe: text(p.EID_DEL_STAVBE),
        eid_stavba: text(p.EID_STAVBA),
        eid_hisna_stevilka: text(p.EID_HISNA_STEVILKA),
        ko_id: integer(p.KO_ID),
        building_number: integer(p.ST_STAVBE),
        part_number: integer(p.ST_DELA_STAVBE),
        actual_use_code: integer(p.VRSTE_DEJANSKIH_RAB_DEL_ST_SIFRA),
        actual_use_name: text(p.VRSTE_DEJANSKIH_RAB_DEL_ST_NAZIV_SL),
        area: numberValue(p.POVRSINA),
        useful_area: numberValue(p.UPORABNA_POVRSINA),
        address: text(p.NASLOV_DELA_STAVBE ?? p.NASLOV),
        apartment_number: integer(p.ST_STANOVANJA),
        floor_label: text(p.ETAZE_DELA_STAVBE),
        main_entrance_floor: integer(p.ST_ETAZE_GLAVNEGA_VHODA),
        elevator_code: integer(p.DVIGALO_SIFRA ?? p.DVIGALO),
        window_renovation_year: integer(p.LETO_OBNOVE_OKEN),
        installation_renovation_year: integer(
          p.LETO_OBNOVE_INSTALACIJ,
        ),
        source_updated_at: text(p.DATUM_SYS),
        source_key: sourceKey("kn-DELI_STAVB"),
      };
    });
  await upsertRows(
    pool,
    "gurs_kn_building_parts",
    ["eid_del_stavbe"],
    buildingParts,
    WRITE_BATCH_SIZE,
    report,
  );
  addSummary(
    summaries,
    {
      source: "KN DELI_STAVB sample",
      rows: buildingParts.length,
    },
    report,
  );

  const buildingParcels = collections
    .get("STAVBE_PARCELE")!
    .features.map((feature) => {
      const p = feature.properties;
      return {
        eid_stavba_parcela: text(p.EID_STAVBA_PARCELA),
        eid_stavba: text(p.EID_STAVBA),
        eid_parcela: text(p.EID_PARCELA),
        relationship_type_id: integer(p.VRSTA_POVEZAVE_ID),
        area: numberValue(p.POVRSINA),
        source_key: sourceKey("kn-STAVBE_PARCELE"),
      };
    });
  await upsertRows(
    pool,
    "gurs_kn_building_parcels",
    ["eid_stavba_parcela"],
    buildingParcels,
    WRITE_BATCH_SIZE,
    report,
  );
  addSummary(
    summaries,
    {
      source: "KN STAVBE_PARCELE sample",
      rows: buildingParcels.length,
    },
    report,
  );

  const municipalities = collections
    .get("KATASTRSKE_OBCINE")!
    .features.map((feature) => {
      const p = feature.properties;
      return {
        eid_katastrska_obcina: text(p.EID_KATASTRSKA_OBCINA),
        ko_id: integer(p.KO_ID),
        name: text(p.NAZIV),
        geometry: feature.geometry ?? null,
        source_updated_at: text(p.DATUM_SYS),
        source_key: sourceKey("kn-KATASTRSKE_OBCINE"),
      };
    });
  await upsertRows(
    pool,
    "gurs_kn_cadastral_municipalities",
    ["eid_katastrska_obcina"],
    municipalities,
    WRITE_BATCH_SIZE,
    report,
  );
  addSummary(
    summaries,
    {
      source: "KN KATASTRSKE_OBCINE sample",
      rows: municipalities.length,
    },
    report,
  );

  const addresses = collections.get("NASLOVI_HS")!.features.map((feature) => {
    const p = feature.properties;
    return {
      eid_hisna_stevilka: text(p.EID_HISNA_STEVILKA),
      eid_stavba: text(p.EID_STAVBA),
      municipality_name: text(p.OBCINA_NAZIV),
      settlement_name: text(p.NASELJE_NAZIV),
      street_name: text(p.ULICA_NAZIV),
      house_number: integer(p.HS_STEVILKA),
      house_number_suffix: text(p.HS_DODATEK),
      postal_code: integer(p.POSTNI_OKOLIS_SIFRA),
      postal_name: text(p.POSTNI_OKOLIS_NAZIV),
      full_address: buildFullAddress(p),
      centroid_e: numberValue(p.E),
      centroid_n: numberValue(p.N),
      source_updated_at: text(p.DATUM_SYS),
      source_key: sourceKey("kn-NASLOVI_HS"),
    };
  });
  await upsertRows(
    pool,
    "gurs_kn_addresses",
    ["eid_hisna_stevilka"],
    addresses,
    WRITE_BATCH_SIZE,
    report,
  );
  addSummary(
    summaries,
    { source: "KN NASLOVI_HS sample", rows: addresses.length },
    report,
  );

  return summaries;
}

async function ingestEv(
  pool: Queryable,
  collections: Map<string, FeatureCollection>,
  report?: ProgressReporter,
): Promise<ImportSummary[]> {
  const summaries: ImportSummary[] = [];

  for (const collection of EV_COLLECTIONS) {
    const data = collections.get(collection);
    if (!data) throw new Error(`Missing EV collection ${collection}`);

    await recordSource(pool, {
      datasetName: `Evidenca vrednotenja – ${collection}`,
      sourceUrl: `${EV_BASE}/${collection}/items`,
      sourceKey: sourceKey(`ev-${collection}`),
      referenceDate: "2025-01-01",
      updateFrequency: "recomputed when source property data changes",
      metadata: {
        service: "OGC API Features",
        collection,
        numberMatched: data.numberMatched ?? null,
        importedSampleRows: data.features.length,
        sourceCrs: "EPSG:3794",
        geometry: "not supplied; join to KN by EID",
      },
    });
  }

  const parcels = collections.get("PARCELA")!.features.map((feature) => {
    const p = feature.properties;
    return {
      eid_parcela: text(p.EID_PARCELA),
      land_rating: integer(p.BONITETA),
      accessibility: integer(p.ODPRTOST),
      site_coefficient: integer(p.RK),
      ev_source_key: sourceKey("ev-PARCELA"),
    };
  });
  await enrichRowsByKey(
    pool,
    "gurs_kn_parcels",
    "eid_parcela",
    parcels,
    {
      land_rating: "integer",
      accessibility: "integer",
      site_coefficient: "integer",
      ev_source_key: "text",
    },
    report,
  );
  addSummary(
    summaries,
    {
      source: "EV PARCELA enrichment sample",
      rows: parcels.length,
    },
    report,
  );

  const parsedParcelUnits = collections
    .get("PARC_ENOTA")!
    .features.map((feature) => {
      const p = feature.properties;
      return {
        parcel_unit_id: text(p.ID_PARC_ENOTA),
        eid_parcela: text(p.EID_PARCELA),
        valuation_model_id: text(p.ID_MODEL),
        valuation_model_name: text(p.NAZIV_MODEL),
        area_share: numberValue(p.DELEZ_POVRSINE),
        value_level: text(p.RAVEN),
        modelled_value: numberValue(p.POSPLOSENA_VREDNOST),
        source_key: sourceKey("ev-PARC_ENOTA"),
      };
    });
  const parcelUnits = filterRequiredRows(parsedParcelUnits, [
    "parcel_unit_id",
    "eid_parcela",
    "valuation_model_id",
    "modelled_value",
  ]);
  await upsertRows(
    pool,
    "gurs_ev_parcel_units",
    ["parcel_unit_id"],
    parcelUnits.validRows,
    WRITE_BATCH_SIZE,
    report,
  );
  addSummary(
    summaries,
    {
      source: "EV PARC_ENOTA sample",
      rows: parcelUnits.validRows.length,
      skippedRows: parcelUnits.skippedRows,
      skipReason: "missing required valuation fields",
    },
    report,
  );

  const buildings = collections.get("STAVBA")!.features.map((feature) => {
    const p = feature.properties;
    return {
      eid_stavba: text(p.EID_STAVBA),
      floor_count: integer(p.ST_ETAZ),
      apartment_count: integer(p.ST_STANOVANJ),
      business_premises_count: integer(p.ST_POSLOVNIH_PROSTOROV),
      gross_floor_area: numberValue(p.POV_STAVBE),
      construction_year: integer(p.LETO_IZG_STA),
      facade_renovation_year: integer(p.LETO_OBN_FASADE),
      roof_renovation_year: integer(p.LETO_OBN_STREHE),
      building_type_code: integer(p.ID_TIP_STAVBE),
      building_type_name: text(p.NAZIV_TIP_STAVBE),
      construction_type_code: integer(p.ID_KONSTRUKCIJA),
      construction_type_name: text(p.NAZIV_KONSTRUKCIJA),
      electricity_code: integer(p.IMA_ELEKTRIKO_DN),
      gas_code: integer(p.IMA_PLIN_DN),
      water_code: integer(p.IMA_VODOVOD_DN),
      sewer_code: integer(p.IMA_KANALIZACIJO_DN),
      ev_source_key: sourceKey("ev-STAVBA"),
    };
  });
  await enrichRowsByKey(
    pool,
    "gurs_kn_buildings",
    "eid_stavba",
    buildings,
    {
      floor_count: "integer",
      apartment_count: "integer",
      business_premises_count: "integer",
      gross_floor_area: "numeric",
      construction_year: "integer",
      facade_renovation_year: "integer",
      roof_renovation_year: "integer",
      building_type_code: "integer",
      building_type_name: "text",
      construction_type_code: "integer",
      construction_type_name: "text",
      electricity_code: "integer",
      gas_code: "integer",
      water_code: "integer",
      sewer_code: "integer",
      ev_source_key: "text",
    },
    report,
  );
  addSummary(
    summaries,
    {
      source: "EV STAVBA enrichment sample",
      rows: buildings.length,
    },
    report,
  );

  const buildingParts = collections
    .get("DEL_STAVBE")!
    .features.map((feature) => {
      const p = feature.properties;
      return {
        eid_del_stavbe: text(p.EID_DEL_STAVBE),
        eid_hisna_stevilka: text(p.EID_HISNE_STEVILKE),
        apartment_number: integer(p.STEV_STAN),
        area: numberValue(p.POVRSINA),
        useful_area: numberValue(p.UPOR_POV),
        actual_use_code: integer(p.ID_DR_DST),
        actual_use_name: text(p.NAZIV_DR_DST),
        floor_number: integer(p.ST_NADSTROPJA),
        position_code: integer(p.ID_LEGA),
        position_name: text(p.NAZIV_LEGA),
        elevator_code: integer(p.IMA_DVIGALO_DN),
        window_renovation_year: integer(p.LETO_OBN_OKEN),
        installation_renovation_year: integer(p.LETO_OBN_INST),
        ev_source_key: sourceKey("ev-DEL_STAVBE"),
      };
    });
  await enrichRowsByKey(
    pool,
    "gurs_kn_building_parts",
    "eid_del_stavbe",
    buildingParts,
    {
      eid_hisna_stevilka: "text",
      apartment_number: "integer",
      area: "numeric",
      useful_area: "numeric",
      actual_use_code: "integer",
      actual_use_name: "text",
      floor_number: "integer",
      position_code: "integer",
      position_name: "text",
      elevator_code: "integer",
      window_renovation_year: "integer",
      installation_renovation_year: "integer",
      ev_source_key: "text",
    },
    report,
  );
  addSummary(
    summaries,
    {
      source: "EV DEL_STAVBE enrichment sample",
      rows: buildingParts.length,
    },
    report,
  );

  const parsedBuildingPartUnits = collections
    .get("DEL_STAVBE_ENOTA")!
    .features.map((feature) => {
      const p = feature.properties;
      return {
        eid_del_stavbe: text(p.EID_DEL_STAVBE),
        valuation_model_id: text(p.ID_MODEL),
        value_level: text(p.RAVEN),
        special_circumstance_effect: numberValue(p.VPLIV),
        modelled_value: numberValue(p.POSPLOSENA_VREDNOST),
        source_key: sourceKey("ev-DEL_STAVBE_ENOTA"),
      };
    });
  const buildingPartUnits = filterRequiredRows(parsedBuildingPartUnits, [
    "eid_del_stavbe",
    "valuation_model_id",
    "modelled_value",
  ]);
  await upsertRows(
    pool,
    "gurs_ev_building_part_units",
    ["eid_del_stavbe"],
    buildingPartUnits.validRows,
    WRITE_BATCH_SIZE,
    report,
  );
  addSummary(
    summaries,
    {
      source: "EV DEL_STAVBE_ENOTA sample",
      rows: buildingPartUnits.validRows.length,
      skippedRows: buildingPartUnits.skippedRows,
      skipReason: "missing required valuation fields",
    },
    report,
  );

  return summaries;
}

async function fetchLiveSamples(
  sampleSize: number,
  report?: ProgressReporter,
  cache?: FetchCache,
): Promise<{
  knResults: Map<string, FeatureCollection>;
  evResults: Map<string, FeatureCollection>;
}> {
  async function fetchGroup(
    baseUrl: string,
    collections: readonly string[],
  ): Promise<Map<string, FeatureCollection>> {
    const results = new Map<string, FeatureCollection>();

    for (const collection of collections) {
      results.set(
        collection,
        await fetchCollection(
          baseUrl,
          collection,
          sampleSize,
          report,
          cache,
        ),
      );
    }

    return results;
  }

  const [knResults, evResults] = await Promise.all([
    fetchGroup(KN_BASE, KN_COLLECTIONS),
    fetchGroup(EV_BASE, EV_COLLECTIONS),
  ]);

  return {
    knResults,
    evResults,
  };
}

async function clearLiveData(pool: Queryable): Promise<void> {
  await pool.query(
    [
      "DELETE FROM gurs_source_retrievals",
      "WHERE source_key LIKE 'kn-%'",
      "   OR source_key LIKE 'ev-%'",
      "   OR source_key LIKE 'address-%'",
    ].join("\n"),
  );
}

async function createStagingTables(pool: Queryable): Promise<void> {
  for (const table of LIVE_DATA_TABLES) {
    await pool.query(
      `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`,
    );
  }
}

async function replaceFromStaging(pool: Queryable): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE ${LIVE_DATA_TABLES.map((table) => `public.${table}`).join(", ")}`,
  );
  for (const table of LIVE_DATA_TABLES) {
    await pool.query(
      `INSERT INTO public.${table} SELECT * FROM pg_temp.${table}`,
    );
  }

  await resolveEtnLinks(pool);
}

async function resolveEtnLinks(pool: Queryable): Promise<void> {
  await pool.query("UPDATE public.gurs_etn_building_parts SET eid_del_stavbe = NULL");
  await pool.query(`
    UPDATE public.gurs_etn_building_parts AS item
    SET eid_del_stavbe = part.eid_del_stavbe
    FROM public.gurs_kn_building_parts AS part
    WHERE
      item.ko_id = part.ko_id
      AND item.building_number = part.building_number
      AND item.part_number = part.part_number
  `);
  await pool.query("UPDATE public.gurs_etn_land SET eid_parcela = NULL");
  await pool.query(`
    UPDATE public.gurs_etn_land AS item
    SET eid_parcela = parcel.eid_parcela
    FROM public.gurs_kn_parcels AS parcel
    WHERE
      item.ko_id = parcel.ko_id
      -- Do not let a locale-dependent btree order drive this join. An index
      -- built under different collation data can make PostgreSQL's merge join
      -- fail with "mergejoin input data is out of order". The C collation is
      -- byte-stable and makes the natural-key comparison deterministic.
      AND item.parcel_number COLLATE "C" = parcel.parcel_number COLLATE "C"
  `);
}

export type LiveIngestResult = {
  retrievedAt: string;
  sampleSize: number;
  transactionYear: number;
  summaries: ImportSummary[];
  coverage?: Coverage;
};

export type LiveIngestOptions = {
  onProgress?: ProgressReporter;
  transactionYear?: number;
};

export async function replaceLiveGursSample(
  pool: Pool,
  requestedSampleSize: unknown,
  options: LiveIngestOptions = {},
): Promise<LiveIngestResult> {
  const sampleSize = validateLiveSampleSize(requestedSampleSize);
  const transactionYear = validateTransactionYear(
    options.transactionYear ?? DEFAULT_TRANSACTION_YEAR,
  );
  const report = options.onProgress;
  const anchors = await loadAnchorSet(
    pool,
    sampleSize,
    transactionYear,
    report,
  );
  const cache = anchors
    ? await prepareFetchCache(
        pool,
        anchors,
        sampleSize,
        transactionYear,
        report,
      )
    : undefined;
  const graph = anchors
    ? await fetchCoherentGraph(anchors, report, cache)
    : {
        ...(await fetchLiveSamples(sampleSize, report, cache)),
        coverage: undefined,
      };
  const { knResults, evResults, coverage } = graph;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('gurs-live-replacement'))",
    );
    await createStagingTables(client);
    await clearLiveData(client);

    const summaries = [
      ...(await ingestKn(client, knResults, report)),
      ...(await ingestEv(client, evResults, report)),
    ];
    await replaceFromStaging(client);
    await refreshMapTables(client);
    if (cache) await clearFetchCache(client, cache);
    report?.({
      phase: "replace",
      source: "live GURS tables",
      message: "Atomically replaced live GURS rows from staging",
      details: {
        tables: [...LIVE_DATA_TABLES],
      },
    });

    await client.query("COMMIT");

    const result = {
      retrievedAt: new Date().toISOString(),
      sampleSize,
      transactionYear,
      summaries,
      ...(coverage ? { coverage } : {}),
    };
    report?.({
      phase: "complete",
      source: "live GURS replacement",
      message: "Committed live GURS replacement",
      details: {
        sampleSize,
        transactionYear,
        importedRows: summaries.reduce(
          (total, summary) => total + summary.rows,
          0,
        ),
        skippedRows: summaries.reduce(
          (total, summary) => total + (summary.skippedRows ?? 0),
          0,
        ),
      },
    });
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function requiredCsv(
  files: string[],
  matcher: (file: string) => boolean,
  description: string,
): string {
  const matches = files.filter(matcher);

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${description} CSV, found ${matches.length}`,
    );
  }

  return matches[0]!;
}

async function loadCsv(directory: string, file: string): Promise<CsvRecord[]> {
  const content = await readFile(join(directory, file), "utf8");
  return parseCsv(content.replace(/^\uFEFF/, ""));
}

function etnSourceKey(file: string): string {
  const archiveDate = /_(\d{8})\.csv$/i.exec(file)?.[1] ?? RETRIEVAL_DATE;
  return `etn-${basename(file, ".csv").toLowerCase()}-${archiveDate}`;
}

async function recordEtnSource(
  pool: Queryable,
  file: string,
  datasetName: string,
  rows: number,
): Promise<void> {
  const archiveDateMatch = /_(\d{4})(\d{2})(\d{2})\.csv$/i.exec(file);
  const referenceDate = archiveDateMatch
    ? `${archiveDateMatch[1]}-${archiveDateMatch[2]}-${archiveDateMatch[3]}`
    : null;

  await recordSource(pool, {
    datasetName,
    sourceUrl:
      "https://ipi.eprostor.gov.si/jgp-service-api/display-views/127/products/321/composites/403/result?years=2025",
    sourceKey: etnSourceKey(file),
    referenceDate,
    updateFrequency: "daily archive build; one archive per transaction year",
    metadata: {
      distribution: "JGP ETN completed sales CSV archive",
      archiveMember: file,
      importedRows: rows,
      transactionYear: 2025,
      historicalCoverageObserved: "2007–current",
    },
  });
}

export async function ingestEtn(
  pool: Pool,
  directory: string,
): Promise<ImportSummary[]> {
  const files = (await readdir(directory)).filter((file) =>
    file.toLowerCase().endsWith(".csv"),
  );
  const transactionFile = requiredCsv(
    files,
    (file) => file.includes("KPP_POSLI"),
    "ETN transaction",
  );
  const buildingPartFile = requiredCsv(
    files,
    (file) => file.includes("KPP_DELISTAVB"),
    "ETN building-part",
  );
  const landFile = requiredCsv(
    files,
    (file) => file.includes("KPP_ZEMLJISCA"),
    "ETN land",
  );
  const codeListFile = requiredCsv(
    files,
    (file) => file.toLowerCase().includes("sifranti"),
    "ETN code-list",
  );
  const [transactionsRaw, buildingPartsRaw, landRaw, codeListsRaw] =
    await Promise.all([
      loadCsv(directory, transactionFile),
      loadCsv(directory, buildingPartFile),
      loadCsv(directory, landFile),
      loadCsv(directory, codeListFile),
    ]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const transactions = transactionsRaw.map((row) => ({
      id_posla: text(row.ID_POSLA),
      transaction_type: integer(row.VRSTA_KUPOPRODAJNEGA_POSLA),
      effective_date: slovenianDate(row.DATUM_UVELJAVITVE),
      contract_date: slovenianDate(row.DATUM_SKLENITVE_POGODBE),
      total_price: numberValue(row.POGODBENA_CENA_ODSKODNINA),
      includes_vat: integer(row.VKLJUCENOST_DDV),
      last_changed_date: slovenianDate(row.DATUM_ZADNJE_SPREMEMBE_POSLA),
      deed_type: integer(row.VRSTA_AKTA),
      marketability: integer(row.TRZNOST_POSLA),
      year: integer(row.LETO),
      source_key: etnSourceKey(transactionFile),
    }));
    await upsertRows(
      client,
      "gurs_etn_transactions",
      ["id_posla"],
      transactions,
    );

    const buildingParts = buildingPartsRaw.map((row, index) => ({
      record_key: `${buildingPartFile}:${index + 2}`,
      id_posla: text(row.ID_POSLA),
      ko_id: integer(row.SIFRA_KO),
      building_number: integer(row.STEVILKA_STAVBE),
      part_number: integer(row.STEVILKA_DELA_STAVBE),
      settlement_name: text(row.NASELJE),
      street_name: text(row.ULICA),
      house_number: text(
        [row.HISNA_STEVILKA, row.DODATEK_HS].filter(Boolean).join(""),
      ),
      property_type: integer(row.VRSTA_DELA_STAVBE),
      construction_year: integer(row.LETO_IZGRADNJE_DELA_STAVBE),
      sold_area: numberValue(row.PRODANA_POVRSINA),
      sold_share: text(row.PRODANI_DELEZ_DELA_STAVBE),
      actual_use: text(row.DEJANSKA_RABA_DELA_STAVBE),
      area: numberValue(row.POVRSINA_DELA_STAVBE),
      useful_area: numberValue(row.UPORABNA_POVRSINA),
      centroid_e: numberValue(row.E_CENTROID),
      centroid_n: numberValue(row.N_CENTROID),
      year: integer(row.LETO),
      source_key: etnSourceKey(buildingPartFile),
    }));
    await upsertRows(
      client,
      "gurs_etn_building_parts",
      ["record_key"],
      buildingParts,
    );

    const land = landRaw.map((row, index) => ({
      record_key: `${landFile}:${index + 2}`,
      id_posla: text(row.ID_POSLA),
      ko_id: integer(row.SIFRA_KO),
      parcel_number: text(row.PARCELNA_STEVILKA),
      land_type: integer(row.VRSTA_ZEMLJISCA),
      sold_share: text(row.PRODANI_DELEZ_PARCELE),
      parcel_area: numberValue(row.POVRSINA_PARCELE),
      centroid_e: numberValue(row.E_CENTROID),
      centroid_n: numberValue(row.N_CENTROID),
      year: integer(row.LETO),
      source_key: etnSourceKey(landFile),
    }));
    await upsertRows(
      client,
      "gurs_etn_land",
      ["record_key"],
      land,
    );

    const codeLists = codeListsRaw.map((row, index) => ({
      record_key: `${codeListFile}:${index + 2}`,
      code_list_id: integer(row.ID),
      code_list_name: text(row.SIFRANT),
      numeric_value: integer(row.NUMERICNA_VREDNOST),
      description: text(row.OPIS),
      source_key: etnSourceKey(codeListFile),
    }));
    await upsertRows(
      client,
      "gurs_etn_code_lists",
      ["record_key"],
      codeLists,
    );

    await recordEtnSource(
      client,
      transactionFile,
      "Evidenca trga nepremičnin – kupoprodajni posli",
      transactions.length,
    );
    await recordEtnSource(
      client,
      buildingPartFile,
      "Evidenca trga nepremičnin – prodani deli stavb",
      buildingParts.length,
    );
    await recordEtnSource(
      client,
      landFile,
      "Evidenca trga nepremičnin – prodana zemljišča",
      land.length,
    );
    await recordEtnSource(
      client,
      codeListFile,
      "Evidenca trga nepremičnin – šifranti",
      codeLists.length,
    );
    await resolveEtnLinks(client);
    await refreshMapTables(client);

    await client.query("COMMIT");

    return [
      { source: "ETN transactions", rows: transactions.length },
      { source: "ETN building parts", rows: buildingParts.length },
      { source: "ETN land", rows: land.length },
      { source: "ETN code lists", rows: codeLists.length },
    ];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
