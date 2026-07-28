import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Pool } from "pg";

import { loadConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { parseCsv, type CsvRecord } from "./csv.js";

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

type ImportSummary = {
  source: string;
  rows: number;
};

type Queryable = {
  query(text: string, values?: unknown[]): Promise<unknown>;
};

const RETRIEVAL_DATE = new Date().toISOString().slice(0, 10);
const LICENCE = "CC BY 4.0";
const KN_BASE =
  "https://ipi.eprostor.gov.si/wfs-si-gurs-kn/ogc/features/collections";
const EV_BASE =
  "https://ipi.eprostor.gov.si/wfs-si-gurs-ev/ogc/features/collections";
const ADDRESS_BASE =
  "https://ipi.eprostor.gov.si/search-api/v1/external/iskanje/naslovi/";

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

async function fetchJson<T>(url: URL | string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json, application/geo+json",
      "user-agent": "property-scraper GURS source validator",
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText} returned by ${response.url}`,
    );
  }

  return (await response.json()) as T;
}

async function fetchCollection(
  baseUrl: string,
  collection: string,
): Promise<FeatureCollection> {
  const url = new URL(`${baseUrl}/${collection}/items`);
  url.searchParams.set("limit", "2");
  return fetchJson<FeatureCollection>(url);
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
  batchSize = 200,
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

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
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
  }
}

async function enrichRowsByKey(
  pool: Queryable,
  table: string,
  keyColumn: string,
  rows: JsonObject[],
): Promise<void> {
  const quotedTable = checkedSqlIdentifier(table);
  const quotedKey = checkedSqlIdentifier(keyColumn);

  for (const row of rows) {
    const key = row[keyColumn];
    const columns = Object.keys(row).filter((column) => column !== keyColumn);
    const values = [key, ...columns.map((column) => row[column] ?? null)];
    const assignments = columns.map((column, index) => {
      const quotedColumn = checkedSqlIdentifier(column);
      const incomingValue = `$${index + 2}`;

      if (column.endsWith("_source_key")) {
        return `${quotedColumn} = ${incomingValue}`;
      }

      return `${quotedColumn} = COALESCE(${quotedTable}.${quotedColumn}, ${incomingValue})`;
    });

    await pool.query(
      `UPDATE ${quotedTable} SET ${assignments.join(", ")} WHERE ${quotedKey} = $1`,
      values,
    );
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
  pool: Pool,
  collections: Map<string, FeatureCollection>,
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
  await upsertRows(pool, "gurs_kn_parcels", ["eid_parcela"], parcels);
  summaries.push({ source: "KN PARCELE sample", rows: parcels.length });

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
        p.OBRIS_GEOM ?? p.NADZEMNI_GEOM ?? p.TLORIS_GEOM ?? null,
      source_updated_at: text(p.DATUM_SYS),
      source_key: sourceKey("kn-STAVBE"),
    };
  });
  await upsertRows(pool, "gurs_kn_buildings", ["eid_stavba"], buildings);
  summaries.push({ source: "KN STAVBE sample", rows: buildings.length });

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
  );
  summaries.push({
    source: "KN DELI_STAVB sample",
    rows: buildingParts.length,
  });

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
  );
  summaries.push({
    source: "KN STAVBE_PARCELE sample",
    rows: buildingParcels.length,
  });

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
  );
  summaries.push({
    source: "KN KATASTRSKE_OBCINE sample",
    rows: municipalities.length,
  });

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
  );
  summaries.push({ source: "KN NASLOVI_HS sample", rows: addresses.length });

  return summaries;
}

async function ingestEv(
  pool: Pool,
  collections: Map<string, FeatureCollection>,
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
  await enrichRowsByKey(pool, "gurs_kn_parcels", "eid_parcela", parcels);
  summaries.push({
    source: "EV PARCELA enrichment sample",
    rows: parcels.length,
  });

  const parcelUnits = collections
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
  await upsertRows(
    pool,
    "gurs_ev_parcel_units",
    ["parcel_unit_id"],
    parcelUnits,
  );
  summaries.push({ source: "EV PARC_ENOTA sample", rows: parcelUnits.length });

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
  await enrichRowsByKey(pool, "gurs_kn_buildings", "eid_stavba", buildings);
  summaries.push({
    source: "EV STAVBA enrichment sample",
    rows: buildings.length,
  });

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
  );
  summaries.push({
    source: "EV DEL_STAVBE enrichment sample",
    rows: buildingParts.length,
  });

  const buildingPartUnits = collections
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
  await upsertRows(
    pool,
    "gurs_ev_building_part_units",
    ["eid_del_stavbe"],
    buildingPartUnits,
  );
  summaries.push({
    source: "EV DEL_STAVBE_ENOTA sample",
    rows: buildingPartUnits.length,
  });

  return summaries;
}

async function ingestAddressSearch(pool: Pool): Promise<ImportSummary[]> {
  const searches = [
    { source: "Naslovi stavb", filter: "trnje 10 4220" },
    { source: "Naslovi stanovanj", filter: "ziherlova 40b 202" },
  ];
  let resultCount = 0;

  for (const search of searches) {
    const url = new URL(ADDRESS_BASE);
    url.searchParams.set("vir", search.source);
    url.searchParams.set("filter", search.filter);
    const data = await fetchJson<FeatureCollection>(url);
    const key = sourceKey(`address-${search.source}`);

    await recordSource(pool, {
      datasetName: `Iskanje naslovov – ${search.source}`,
      sourceUrl: url.toString(),
      sourceKey: key,
      updateFrequency: "live service",
      metadata: {
        importedSampleRows: data.features.length,
        documentedExample: true,
        coordinates: "EPSG:3794",
      },
    });
    resultCount += data.features.length;
  }

  return [
    {
      source: "Address API validation (metadata only)",
      rows: resultCount,
    },
  ];
}

async function ingestLiveSamples(pool: Pool): Promise<ImportSummary[]> {
  const [knResults, evResults] = await Promise.all([
    Promise.all(
      KN_COLLECTIONS.map(async (collection) => [
        collection,
        await fetchCollection(KN_BASE, collection),
      ] as const),
    ),
    Promise.all(
      EV_COLLECTIONS.map(async (collection) => [
        collection,
        await fetchCollection(EV_BASE, collection),
      ] as const),
    ),
  ]);

  return [
    ...(await ingestKn(pool, new Map(knResults))),
    ...(await ingestEv(pool, new Map(evResults))),
    ...(await ingestAddressSearch(pool)),
  ];
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

async function ingestEtn(
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

function getArgument(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(
    prefix.length,
  ) ?? null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createDatabase(config);
  const etnDirectory = getArgument("etn-dir");
  const skipLive = process.argv.includes("--skip-live");
  const summaries: ImportSummary[] = [];

  try {
    if (!skipLive) {
      summaries.push(...(await ingestLiveSamples(pool)));
    }

    if (etnDirectory) {
      summaries.push(...(await ingestEtn(pool, etnDirectory)));
    }

    if (skipLive && !etnDirectory) {
      throw new Error("Nothing to import: --skip-live requires --etn-dir");
    }

    console.log(JSON.stringify({ retrievedAt: new Date(), summaries }, null, 2));
  } finally {
    await pool.end();
  }
}

await main();
