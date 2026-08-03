import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Pool } from "pg";

import {
  ApiValidationError,
  assertKnownFilters,
  encodeCursor,
  parseBbox,
  parseBooleanFilter,
  parseNumberFilter,
  parsePage,
  serializeRow,
  singleQueryValue,
  type QueryParameters,
} from "../gurs/query.js";

type FilterKind = "exact" | "numberMin" | "numberMax" | "dateMin" | "dateMax" | "search";
type FilterDefinition = {
  column: string;
  kind: FilterKind;
  clause?: (parameter: string, operator: string) => string;
};

type ListDefinition = {
  from: string;
  select: string;
  cursorColumn: string;
  cursorResult: string;
  filters: Record<string, FilterDefinition>;
  bboxGeometry?: string;
  bboxClause?: (envelope: string) => string;
  numericFields?: ReadonlySet<string>;
};

type QueryResult<Row> = {
  rows: Row[];
  rowCount: number | null;
};

const numeric = (...fields: string[]): ReadonlySet<string> => new Set(fields);

function addValue(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

function buildFilters(
  query: QueryParameters,
  definition: ListDefinition,
  values: unknown[],
): string[] {
  const clauses: string[] = [];

  for (const [name, filter] of Object.entries(definition.filters)) {
    const value = singleQueryValue(query, name);
    if (value === undefined) continue;

    if (filter.kind === "search") {
      const parameter = addValue(values, value);
      clauses.push(
        filter.clause?.(parameter, "=") ??
          `(${filter.column} % ${parameter} OR ${filter.column} ILIKE '%' || ${parameter} || '%')`,
      );
    } else if (filter.kind === "numberMin" || filter.kind === "numberMax") {
      const parameter = addValue(values, parseNumberFilter(value, name));
      const operator = filter.kind === "numberMin" ? ">=" : "<=";
      clauses.push(
        filter.clause?.(parameter, operator) ??
          `${filter.column} ${operator} ${parameter}`,
      );
    } else if (filter.kind === "dateMin" || filter.kind === "dateMax") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new ApiValidationError(`${name} must use YYYY-MM-DD`);
      }
      const parameter = addValue(values, value);
      const operator = filter.kind === "dateMin" ? ">=" : "<=";
      clauses.push(
        filter.clause?.(`${parameter}::date`, operator) ??
          `${filter.column} ${operator} ${parameter}::date`,
      );
    } else {
      const parsed =
        value === "true" || value === "false"
          ? parseBooleanFilter(value, name)
          : value;
      const parameter = addValue(values, parsed);
      clauses.push(
        filter.clause?.(parameter, "=") ??
          `${filter.column} = ${parameter}`,
      );
    }
  }

  const bboxValue = singleQueryValue(query, "bbox");
  if (bboxValue !== undefined) {
    if (!definition.bboxGeometry && !definition.bboxClause) {
      throw new ApiValidationError("bbox is not supported for this resource");
    }
    const [minLon, minLat, maxLon, maxLat] = parseBbox(bboxValue);
    const placeholders = [minLon, minLat, maxLon, maxLat].map((coordinate) =>
      addValue(values, coordinate),
    );
    const envelope = `ST_MakeEnvelope(${placeholders.join(", ")}, 4326)`;
    clauses.push(
      definition.bboxClause?.(envelope) ??
        `${definition.bboxGeometry} && ${envelope}`,
    );
  }

  return clauses;
}

async function listResource(
  database: Pool,
  query: QueryParameters,
  definition: ListDefinition,
): Promise<{
  items: Record<string, unknown>[];
  page: { nextCursor: string | null; hasMore: boolean };
}> {
  assertKnownFilters(query, [
    ...Object.keys(definition.filters),
    ...(definition.bboxGeometry || definition.bboxClause ? ["bbox"] : []),
  ]);
  const page = parsePage(query);
  const values: unknown[] = [];
  const clauses = buildFilters(query, definition, values);
  if (page.cursor) {
    clauses.push(
      `${definition.cursorColumn}::text > ${addValue(values, page.cursor)}`,
    );
  }
  const limitParameter = addValue(values, page.limit + 1);
  const result = (await database.query(
    `
      SELECT ${definition.select}
      FROM ${definition.from}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY ${definition.cursorColumn}::text ASC
      LIMIT ${limitParameter}
    `,
    values,
  )) as QueryResult<Record<string, unknown>>;
  const hasMore = result.rows.length > page.limit;
  const rows = result.rows.slice(0, page.limit);
  const last = rows.at(-1);
  const cursorValue = last?.[definition.cursorResult];

  return {
    items: rows.map((row) => serializeRow(row, definition.numericFields)),
    page: {
      nextCursor:
        hasMore && cursorValue !== null && cursorValue !== undefined
          ? encodeCursor(String(cursorValue))
          : null,
      hasMore,
    },
  };
}

async function detailRow(
  database: Pool,
  reply: FastifyReply,
  sql: string,
  values: unknown[],
  numericFields?: ReadonlySet<string>,
): Promise<Record<string, unknown> | FastifyReply> {
  const result = (await database.query(sql, values)) as QueryResult<
    Record<string, unknown>
  >;
  const row = result.rows[0];
  if (!row) {
    return reply.code(404).send({
      error: "Not Found",
      message: "The requested GURS resource does not exist",
      statusCode: 404,
    });
  }
  return serializeRow(row, numericFields);
}

const sources: ListDefinition = {
  from: "public.gurs_source_retrievals AS source",
  select: "source.*",
  cursorColumn: "source.source_key",
  cursorResult: "source_key",
  filters: {
    datasetName: { column: "source.dataset_name", kind: "search" },
    referenceDateMin: { column: "source.reference_date", kind: "dateMin" },
    referenceDateMax: { column: "source.reference_date", kind: "dateMax" },
    nationwide: { column: "source.nationwide", kind: "exact" },
  },
};

const municipalities: ListDefinition = {
  from: `
    public.gurs_kn_cadastral_municipalities AS municipality
    LEFT JOIN map.cadastral AS map_feature USING (eid_katastrska_obcina)
  `,
  select: "municipality.*",
  cursorColumn: "municipality.eid_katastrska_obcina",
  cursorResult: "eid_katastrska_obcina",
  filters: {
    koId: { column: "municipality.ko_id", kind: "exact" },
    name: { column: "municipality.name", kind: "search" },
  },
  bboxGeometry: "map_feature.geom",
};

const addresses: ListDefinition = {
  from: `
    public.gurs_kn_addresses AS address
    LEFT JOIN map.properties AS map_feature USING (eid_stavba)
  `,
  select: "address.*",
  cursorColumn: "address.eid_hisna_stevilka",
  cursorResult: "eid_hisna_stevilka",
  filters: {
    eidStavba: { column: "address.eid_stavba", kind: "exact" },
    municipalityName: { column: "address.municipality_name", kind: "exact" },
    settlementName: { column: "address.settlement_name", kind: "exact" },
    streetName: { column: "address.street_name", kind: "search" },
    fullAddress: { column: "address.full_address", kind: "search" },
    postalCode: { column: "address.postal_code", kind: "exact" },
    parcelId: {
      column: "address.eid_stavba",
      kind: "exact",
      clause: (parameter) => `
        EXISTS (
          SELECT 1 FROM gurs_kn_building_parcels relation
          WHERE relation.eid_stavba = address.eid_stavba
            AND relation.eid_parcela = ${parameter}
        )
      `,
    },
  },
  bboxGeometry: "map_feature.pin",
  numericFields: numeric("centroid_e", "centroid_n"),
};

const parcels: ListDefinition = {
  from: `
    public.gurs_kn_parcels AS parcel
    LEFT JOIN map.parcels AS map_feature USING (eid_parcela)
  `,
  select: "parcel.*",
  cursorColumn: "parcel.eid_parcela",
  cursorResult: "eid_parcela",
  filters: {
    koId: { column: "parcel.ko_id", kind: "exact" },
    parcelNumber: { column: "parcel.parcel_number", kind: "exact" },
    administrativeStatusCode: {
      column: "parcel.administrative_status_code",
      kind: "exact",
    },
    areaMin: { column: "parcel.area", kind: "numberMin" },
    areaMax: { column: "parcel.area", kind: "numberMax" },
    landRatingMin: { column: "parcel.land_rating", kind: "numberMin" },
    landRatingMax: { column: "parcel.land_rating", kind: "numberMax" },
    eidStavba: {
      column: "parcel.eid_parcela",
      kind: "exact",
      clause: (parameter) => `
        EXISTS (
          SELECT 1 FROM gurs_kn_building_parcels relation
          WHERE relation.eid_parcela = parcel.eid_parcela
            AND relation.eid_stavba = ${parameter}
        )
      `,
    },
    valuationValueMin: {
      column: "parcel.eid_parcela",
      kind: "numberMin",
      clause: (parameter, operator) => `
        EXISTS (
          SELECT 1 FROM gurs_ev_parcel_units valuation
          WHERE valuation.eid_parcela = parcel.eid_parcela
            AND valuation.modelled_value ${operator} ${parameter}
        )
      `,
    },
    valuationValueMax: {
      column: "parcel.eid_parcela",
      kind: "numberMax",
      clause: (parameter, operator) => `
        EXISTS (
          SELECT 1 FROM gurs_ev_parcel_units valuation
          WHERE valuation.eid_parcela = parcel.eid_parcela
            AND valuation.modelled_value ${operator} ${parameter}
        )
      `,
    },
  },
  bboxGeometry: "map_feature.geom",
  numericFields: numeric("area", "centroid_e", "centroid_n"),
};

const buildings: ListDefinition = {
  from: `
    public.gurs_kn_buildings AS building
    LEFT JOIN map.properties AS map_feature USING (eid_stavba)
  `,
  select: "building.*",
  cursorColumn: "building.eid_stavba",
  cursorResult: "eid_stavba",
  filters: {
    koId: { column: "building.ko_id", kind: "exact" },
    buildingNumber: { column: "building.building_number", kind: "exact" },
    buildingTypeCode: { column: "building.building_type_code", kind: "exact" },
    buildingTypeName: {
      column: "building.building_type_name",
      kind: "search",
    },
    constructionTypeCode: {
      column: "building.construction_type_code",
      kind: "exact",
    },
    floorCountMin: { column: "building.floor_count", kind: "numberMin" },
    floorCountMax: { column: "building.floor_count", kind: "numberMax" },
    areaMin: { column: "building.gross_floor_area", kind: "numberMin" },
    areaMax: { column: "building.gross_floor_area", kind: "numberMax" },
    constructionYearMin: {
      column: "building.construction_year",
      kind: "numberMin",
    },
    constructionYearMax: {
      column: "building.construction_year",
      kind: "numberMax",
    },
    parcelId: {
      column: "building.eid_stavba",
      kind: "exact",
      clause: (parameter) => `
        EXISTS (
          SELECT 1 FROM gurs_kn_building_parcels relation
          WHERE relation.eid_stavba = building.eid_stavba
            AND relation.eid_parcela = ${parameter}
        )
      `,
    },
  },
  bboxGeometry: "map_feature.pin",
  numericFields: numeric("gross_floor_area", "centroid_e", "centroid_n"),
};

const buildingParts: ListDefinition = {
  from: `
    public.gurs_kn_building_parts AS part
    LEFT JOIN map.properties AS map_feature USING (eid_stavba)
  `,
  select: "part.*",
  cursorColumn: "part.eid_del_stavbe",
  cursorResult: "eid_del_stavbe",
  filters: {
    eidStavba: { column: "part.eid_stavba", kind: "exact" },
    koId: { column: "part.ko_id", kind: "exact" },
    buildingNumber: { column: "part.building_number", kind: "exact" },
    partNumber: { column: "part.part_number", kind: "exact" },
    actualUseCode: { column: "part.actual_use_code", kind: "exact" },
    actualUseName: { column: "part.actual_use_name", kind: "search" },
    address: { column: "part.address", kind: "search" },
    areaMin: { column: "part.area", kind: "numberMin" },
    areaMax: { column: "part.area", kind: "numberMax" },
    usefulAreaMin: { column: "part.useful_area", kind: "numberMin" },
    usefulAreaMax: { column: "part.useful_area", kind: "numberMax" },
    floorMin: { column: "part.floor_number", kind: "numberMin" },
    floorMax: { column: "part.floor_number", kind: "numberMax" },
    valuationValueMin: {
      column: "part.eid_del_stavbe",
      kind: "numberMin",
      clause: (parameter, operator) => `
        EXISTS (
          SELECT 1 FROM gurs_ev_building_part_units valuation
          WHERE valuation.eid_del_stavbe = part.eid_del_stavbe
            AND valuation.modelled_value ${operator} ${parameter}
        )
      `,
    },
    valuationValueMax: {
      column: "part.eid_del_stavbe",
      kind: "numberMax",
      clause: (parameter, operator) => `
        EXISTS (
          SELECT 1 FROM gurs_ev_building_part_units valuation
          WHERE valuation.eid_del_stavbe = part.eid_del_stavbe
            AND valuation.modelled_value ${operator} ${parameter}
        )
      `,
    },
    parcelId: {
      column: "part.eid_stavba",
      kind: "exact",
      clause: (parameter) => `
        EXISTS (
          SELECT 1 FROM gurs_kn_building_parcels relation
          WHERE relation.eid_stavba = part.eid_stavba
            AND relation.eid_parcela = ${parameter}
        )
      `,
    },
  },
  bboxGeometry: "map_feature.pin",
  numericFields: numeric("area", "useful_area"),
};

const transactions: ListDefinition = {
  from: "public.gurs_etn_transactions AS transaction",
  select: "transaction.*, transaction.id_posla::text AS id_posla",
  cursorColumn: "transaction.id_posla",
  cursorResult: "id_posla",
  filters: {
    transactionType: {
      column: "transaction.transaction_type",
      kind: "exact",
    },
    includesVat: { column: "transaction.includes_vat", kind: "exact" },
    deedType: { column: "transaction.deed_type", kind: "exact" },
    marketability: { column: "transaction.marketability", kind: "exact" },
    year: { column: "transaction.year", kind: "exact" },
    priceMin: { column: "transaction.total_price", kind: "numberMin" },
    priceMax: { column: "transaction.total_price", kind: "numberMax" },
    contractDateMin: {
      column: "transaction.contract_date",
      kind: "dateMin",
    },
    contractDateMax: {
      column: "transaction.contract_date",
      kind: "dateMax",
    },
    parcelId: {
      column: "transaction.id_posla",
      kind: "exact",
      clause: (parameter) => `
        EXISTS (
          SELECT 1 FROM gurs_etn_land item
          WHERE item.id_posla = transaction.id_posla
            AND item.eid_parcela = ${parameter}
        )
      `,
    },
    eidDelStavbe: {
      column: "transaction.id_posla",
      kind: "exact",
      clause: (parameter) => `
        EXISTS (
          SELECT 1 FROM gurs_etn_building_parts item
          WHERE item.id_posla = transaction.id_posla
            AND item.eid_del_stavbe = ${parameter}
        )
      `,
    },
    eidStavba: {
      column: "transaction.id_posla",
      kind: "exact",
      clause: (parameter) => `
        EXISTS (
          SELECT 1
          FROM gurs_etn_building_parts item
          JOIN gurs_kn_building_parts part USING (eid_del_stavbe)
          WHERE item.id_posla = transaction.id_posla
            AND part.eid_stavba = ${parameter}
        )
      `,
    },
  },
  bboxClause: (envelope) => `
    EXISTS (
      SELECT 1 FROM map.sales AS sale
      WHERE sale.transaction_id = transaction.id_posla::text
        AND sale.geom && ${envelope}
    )
  `,
  numericFields: numeric("total_price"),
};

const codeLists: ListDefinition = {
  from: "public.gurs_etn_code_lists AS code",
  select: "code.*",
  cursorColumn: "code.record_key",
  cursorResult: "record_key",
  filters: {
    codeListId: { column: "code.code_list_id", kind: "exact" },
    codeListName: { column: "code.code_list_name", kind: "exact" },
    numericValue: { column: "code.numeric_value", kind: "exact" },
    description: { column: "code.description", kind: "search" },
  },
};

export function readRoutes(database: Pool): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Querystring: QueryParameters }>("/gurs/sources", async (request) =>
      listResource(database, request.query, sources),
    );
    app.get<{ Params: { id: string } }>(
      "/gurs/sources/:id",
      async (request, reply) =>
        detailRow(
          database,
          reply,
          "SELECT * FROM public.gurs_source_retrievals WHERE source_key = $1",
          [request.params.id],
        ),
    );

    app.get("/gurs/statistics", async () => {
      const result = (await database.query(`
        SELECT
          (SELECT count(*) FROM gurs_etn_transactions)::int AS transactions,
          (SELECT count(*) FROM gurs_etn_building_parts)::int AS building_part_sales,
          (SELECT count(*) FROM gurs_etn_land)::int AS land_sales,
          (SELECT count(*) FROM gurs_kn_buildings)::int AS buildings,
          (SELECT count(*) FROM gurs_kn_building_parts)::int AS building_parts,
          (SELECT count(*) FROM gurs_kn_parcels)::int AS parcels,
          (SELECT count(*) FROM gurs_kn_addresses)::int AS addresses,
          (SELECT count(*) FROM gurs_kn_cadastral_municipalities)::int AS cadastral_municipalities
      `)) as QueryResult<Record<string, unknown>>;
      return serializeRow(result.rows[0] ?? {});
    });
    app.get<{ Params: { resource: string } }>(
      "/gurs/statistics/:resource",
      async (request, reply) => {
        const resources: Record<string, string> = {
          transactions: "gurs_etn_transactions",
          buildings: "gurs_kn_buildings",
          "building-parts": "gurs_kn_building_parts",
          parcels: "gurs_kn_parcels",
          addresses: "gurs_kn_addresses",
        };
        const table = resources[request.params.resource];
        if (!table) {
          return reply.code(404).send({
            error: "Not Found",
            message: "Unknown statistics resource",
            statusCode: 404,
          });
        }
        const result = (await database.query(
          `SELECT count(*)::int AS count FROM ${table}`,
        )) as QueryResult<Record<string, unknown>>;
        return {
          resource: request.params.resource,
          count: Number(result.rows[0]?.count ?? 0),
        };
      },
    );

    app.get<{ Querystring: QueryParameters }>(
      "/gurs/cadastral-municipalities",
      async (request) => listResource(database, request.query, municipalities),
    );
    app.get<{ Params: { id: string } }>(
      "/gurs/cadastral-municipalities/:id",
      async (request, reply) => {
        const entity = await detailRow(
          database,
          reply,
          "SELECT * FROM gurs_kn_cadastral_municipalities WHERE eid_katastrska_obcina = $1",
          [request.params.id],
        );
        if ("statusCode" in entity) return entity;
        const koId = entity.koId;
        return {
          ...entity,
          relationships: {
            buildings: { href: `/gurs/buildings?koId=${koId}` },
            parcels: { href: `/gurs/parcels?koId=${koId}` },
          },
        };
      },
    );

    app.get<{ Querystring: QueryParameters }>(
      "/gurs/addresses",
      async (request) => listResource(database, request.query, addresses),
    );
    app.get<{ Params: { id: string } }>(
      "/gurs/addresses/:id",
      async (request, reply) => {
        const entity = await detailRow(
          database,
          reply,
          "SELECT * FROM gurs_kn_addresses WHERE eid_hisna_stevilka = $1",
          [request.params.id],
        );
        if ("statusCode" in entity) return entity;
        return {
          ...entity,
          relationships: {
            building: {
              id: entity.eidStavba,
              href: `/gurs/buildings/${entity.eidStavba}`,
            },
          },
        };
      },
    );

    app.get<{ Querystring: QueryParameters }>(
      "/gurs/parcels",
      async (request) => listResource(database, request.query, parcels),
    );
    app.get<{ Params: { id: string } }>(
      "/gurs/parcels/:id",
      async (request, reply) => {
        const entity = await detailRow(
          database,
          reply,
          `
            SELECT parcel.*
            FROM gurs_kn_parcels parcel
            WHERE parcel.eid_parcela = $1
          `,
          [request.params.id],
          parcels.numericFields,
        );
        if ("statusCode" in entity) return entity;

        const [
          buildingResult,
          valuationResult,
          addressResult,
          partResult,
          saleResult,
        ] = (await Promise.all([
          database.query(
            `
              SELECT building.*
              FROM gurs_kn_buildings building
              WHERE EXISTS (
                SELECT 1
                FROM gurs_kn_building_parcels relation
                WHERE relation.eid_stavba = building.eid_stavba
                  AND relation.eid_parcela = $1
              )
              ORDER BY building.eid_stavba
            `,
            [request.params.id],
          ),
          database.query(
            `
              SELECT *
              FROM gurs_ev_parcel_units
              WHERE eid_parcela = $1
              ORDER BY parcel_unit_id
            `,
            [request.params.id],
          ),
          database.query(
            `
              SELECT address.*
              FROM gurs_kn_addresses address
              WHERE EXISTS (
                SELECT 1
                FROM gurs_kn_building_parcels relation
                WHERE relation.eid_stavba = address.eid_stavba
                  AND relation.eid_parcela = $1
              )
              ORDER BY address.eid_hisna_stevilka
            `,
            [request.params.id],
          ),
          database.query(
            `
              SELECT part.*
              FROM gurs_kn_building_parts part
              WHERE EXISTS (
                SELECT 1
                FROM gurs_kn_building_parcels relation
                WHERE relation.eid_stavba = part.eid_stavba
                  AND relation.eid_parcela = $1
              )
              ORDER BY part.eid_del_stavbe
            `,
            [request.params.id],
          ),
          database.query(
            `
              SELECT transaction.*, transaction.id_posla::text AS id_posla
              FROM gurs_etn_transactions transaction
              WHERE EXISTS (
                SELECT 1
                FROM gurs_etn_land item
                WHERE item.id_posla = transaction.id_posla
                  AND item.eid_parcela = $1
              )
              ORDER BY transaction.id_posla
            `,
            [request.params.id],
          ),
        ])) as [
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
        ];

        return {
          ...entity,
          buildings: buildingResult.rows.map((row) =>
            serializeRow(row, buildings.numericFields),
          ),
          valuationUnits: valuationResult.rows.map((row) =>
            serializeRow(row, numeric("area_share", "modelled_value")),
          ),
          addresses: addressResult.rows.map((row) =>
            serializeRow(row, addresses.numericFields),
          ),
          parts: partResult.rows.map((row) =>
            serializeRow(row, buildingParts.numericFields),
          ),
          sales: saleResult.rows.map((row) =>
            serializeRow(row, transactions.numericFields),
          ),
        };
      },
    );

    app.get<{ Querystring: QueryParameters }>(
      "/gurs/buildings",
      async (request) => listResource(database, request.query, buildings),
    );
    app.get<{ Params: { id: string } }>(
      "/gurs/buildings/:id",
      async (request, reply) => {
        const entity = await detailRow(
          database,
          reply,
          `
            SELECT building.*
            FROM gurs_kn_buildings building
            WHERE building.eid_stavba = $1
          `,
          [request.params.id],
          buildings.numericFields,
        );
        if ("statusCode" in entity) return entity;

        const [
          addressResult,
          partResult,
          parcelResult,
          valuationResult,
          saleResult,
        ] = (await Promise.all([
          database.query(
            `
              SELECT *
              FROM gurs_kn_addresses
              WHERE eid_stavba = $1
              ORDER BY eid_hisna_stevilka
            `,
            [request.params.id],
          ),
          database.query(
            `
              SELECT *
              FROM gurs_kn_building_parts
              WHERE eid_stavba = $1
              ORDER BY eid_del_stavbe
            `,
            [request.params.id],
          ),
          database.query(
            `
              SELECT parcel.*
              FROM gurs_kn_parcels parcel
              JOIN gurs_kn_building_parcels relation USING (eid_parcela)
              WHERE relation.eid_stavba = $1
              ORDER BY parcel.eid_parcela
            `,
            [request.params.id],
          ),
          database.query(
            `
              SELECT valuation.*
              FROM gurs_ev_building_part_units valuation
              JOIN gurs_kn_building_parts part USING (eid_del_stavbe)
              WHERE part.eid_stavba = $1
              ORDER BY valuation.eid_del_stavbe
            `,
            [request.params.id],
          ),
          database.query(
            `
              SELECT transaction.*, transaction.id_posla::text AS id_posla
              FROM gurs_etn_transactions transaction
              WHERE EXISTS (
                SELECT 1
                FROM gurs_etn_building_parts item
                JOIN gurs_kn_building_parts part USING (eid_del_stavbe)
                WHERE item.id_posla = transaction.id_posla
                  AND part.eid_stavba = $1
              )
              ORDER BY transaction.id_posla
            `,
            [request.params.id],
          ),
        ])) as [
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
        ];

        return {
          ...entity,
          addresses: addressResult.rows.map((row) =>
            serializeRow(row, addresses.numericFields),
          ),
          parts: partResult.rows.map((row) =>
            serializeRow(row, buildingParts.numericFields),
          ),
          parcels: parcelResult.rows.map((row) =>
            serializeRow(row, parcels.numericFields),
          ),
          valuationUnits: valuationResult.rows.map((row) =>
            serializeRow(
              row,
              numeric("special_circumstance_effect", "modelled_value"),
            ),
          ),
          sales: saleResult.rows.map((row) =>
            serializeRow(row, transactions.numericFields),
          ),
        };
      },
    );

    app.get<{ Querystring: QueryParameters }>(
      "/gurs/building-parts",
      async (request) => listResource(database, request.query, buildingParts),
    );
    app.get<{ Params: { id: string } }>(
      "/gurs/building-parts/:id",
      async (request, reply) => {
        const entity = await detailRow(
          database,
          reply,
          `
            SELECT part.*
            FROM gurs_kn_building_parts part
            WHERE part.eid_del_stavbe = $1
          `,
          [request.params.id],
          buildingParts.numericFields,
        );
        if ("statusCode" in entity) return entity;

        const [
          buildingResult,
          addressResult,
          parcelResult,
          valuationResult,
          saleResult,
        ] = (await Promise.all([
          database.query(
            `
              SELECT *
              FROM gurs_kn_buildings
              WHERE eid_stavba = $1
            `,
            [entity.eidStavba],
          ),
          database.query(
            `
              SELECT *
              FROM gurs_kn_addresses
              WHERE eid_stavba = $1
              ORDER BY eid_hisna_stevilka
            `,
            [entity.eidStavba],
          ),
          database.query(
            `
              SELECT parcel.*
              FROM gurs_kn_parcels parcel
              JOIN gurs_kn_building_parcels relation USING (eid_parcela)
              WHERE relation.eid_stavba = $1
              ORDER BY parcel.eid_parcela
            `,
            [entity.eidStavba],
          ),
          database.query(
            `
              SELECT *
              FROM gurs_ev_building_part_units
              WHERE eid_del_stavbe = $1
              ORDER BY eid_del_stavbe
            `,
            [request.params.id],
          ),
          database.query(
            `
              SELECT transaction.*, transaction.id_posla::text AS id_posla
              FROM gurs_etn_transactions transaction
              WHERE EXISTS (
                SELECT 1
                FROM gurs_etn_building_parts item
                WHERE item.id_posla = transaction.id_posla
                  AND item.eid_del_stavbe = $1
              )
              ORDER BY transaction.id_posla
            `,
            [request.params.id],
          ),
        ])) as [
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
        ];

        const building = buildingResult.rows[0];
        return {
          ...entity,
          building: building
            ? serializeRow(building, buildings.numericFields)
            : null,
          addresses: addressResult.rows.map((row) =>
            serializeRow(row, addresses.numericFields),
          ),
          parcels: parcelResult.rows.map((row) =>
            serializeRow(row, parcels.numericFields),
          ),
          valuationUnits: valuationResult.rows.map((row) =>
            serializeRow(
              row,
              numeric("special_circumstance_effect", "modelled_value"),
            ),
          ),
          sales: saleResult.rows.map((row) =>
            serializeRow(row, transactions.numericFields),
          ),
        };
      },
    );

    app.get<{ Params: { id: string }; Querystring: QueryParameters }>(
      "/gurs/buildings/:id/valuation-units",
      async (request) => {
        assertKnownFilters(request.query, []);
        const page = parsePage(request.query);
        const values: unknown[] = [request.params.id];
        const cursorClause = page.cursor
          ? `AND valuation.eid_del_stavbe > ${addValue(values, page.cursor)}`
          : "";
        values.push(page.limit + 1);
        const result = (await database.query(
          `
            SELECT valuation.*
            FROM gurs_ev_building_part_units valuation
            JOIN gurs_kn_building_parts part USING (eid_del_stavbe)
            WHERE part.eid_stavba = $1
              ${cursorClause}
            ORDER BY valuation.eid_del_stavbe
            LIMIT $${values.length}
          `,
          values,
        )) as QueryResult<Record<string, unknown>>;
        const hasMore = result.rows.length > page.limit;
        const rows = result.rows.slice(0, page.limit);
        return {
          items: rows.map((row) =>
            serializeRow(
              row,
              numeric(
                "special_circumstance_effect",
                "modelled_value",
              ),
            ),
          ),
          page: {
            nextCursor:
              hasMore && rows.length
                ? encodeCursor(String(rows.at(-1)?.eid_del_stavbe))
                : null,
            hasMore,
          },
        };
      },
    );
    app.get<{ Params: { id: string }; Querystring: QueryParameters }>(
      "/gurs/building-parts/:id/valuation-units",
      async (request) => {
        assertKnownFilters(request.query, []);
        const page = parsePage(request.query);
        const result = (await database.query(
          `
            SELECT *
            FROM gurs_ev_building_part_units
            WHERE eid_del_stavbe = $1
            ORDER BY eid_del_stavbe
            LIMIT $2
          `,
          [request.params.id, page.limit + 1],
        )) as QueryResult<Record<string, unknown>>;
        const rows = result.rows.slice(0, page.limit);
        return {
          items: rows.map((row) =>
            serializeRow(
              row,
              numeric(
                "special_circumstance_effect",
                "modelled_value",
              ),
            ),
          ),
          page: { nextCursor: null, hasMore: result.rows.length > page.limit },
        };
      },
    );
    app.get<{ Params: { id: string }; Querystring: QueryParameters }>(
      "/gurs/parcels/:id/valuation-units",
      async (request) => {
        assertKnownFilters(request.query, []);
        const page = parsePage(request.query);
        const values: unknown[] = [request.params.id];
        const cursorClause = page.cursor
          ? `AND parcel_unit_id > ${addValue(values, page.cursor)}`
          : "";
        values.push(page.limit + 1);
        const result = (await database.query(
          `
            SELECT *
            FROM gurs_ev_parcel_units
            WHERE eid_parcela = $1
              ${cursorClause}
            ORDER BY parcel_unit_id
            LIMIT $${values.length}
          `,
          values,
        )) as QueryResult<Record<string, unknown>>;
        const rows = result.rows.slice(0, page.limit);
        return {
          items: rows.map((row) =>
            serializeRow(row, numeric("area_share", "modelled_value")),
          ),
          page: {
            nextCursor:
              result.rows.length > page.limit && rows.length
                ? encodeCursor(String(rows.at(-1)?.parcel_unit_id))
                : null,
            hasMore: result.rows.length > page.limit,
          },
        };
      },
    );

    app.get<{ Querystring: QueryParameters }>(
      "/gurs/transactions",
      async (request) => listResource(database, request.query, transactions),
    );
    app.get<{ Params: { id: string } }>(
      "/gurs/transactions/:id",
      async (request, reply) => {
        const transaction = await detailRow(
          database,
          reply,
          `
            SELECT transaction.*, transaction.id_posla::text AS id_posla
            FROM gurs_etn_transactions transaction
            WHERE transaction.id_posla = $1
          `,
          [request.params.id],
          transactions.numericFields,
        );
        if ("statusCode" in transaction) return transaction;
        const [partResult, landResult] = (await Promise.all([
          database.query(
            `
              SELECT *, id_posla::text AS id_posla
              FROM gurs_etn_building_parts
              WHERE id_posla = $1
              ORDER BY record_key
            `,
            [request.params.id],
          ),
          database.query(
            `
              SELECT *, id_posla::text AS id_posla
              FROM gurs_etn_land
              WHERE id_posla = $1
              ORDER BY record_key
            `,
            [request.params.id],
          ),
        ])) as [
          QueryResult<Record<string, unknown>>,
          QueryResult<Record<string, unknown>>,
        ];
        return {
          ...transaction,
          items: {
            buildingParts: partResult.rows.map((row) =>
              serializeRow(
                row,
                numeric(
                  "sold_area",
                  "area",
                  "useful_area",
                  "centroid_e",
                  "centroid_n",
                ),
              ),
            ),
            land: landResult.rows.map((row) =>
              serializeRow(
                row,
                numeric("parcel_area", "centroid_e", "centroid_n"),
              ),
            ),
          },
        };
      },
    );

    app.get<{ Querystring: QueryParameters }>(
      "/gurs/code-lists",
      async (request) => listResource(database, request.query, codeLists),
    );
    app.get<{ Params: { id: string } }>(
      "/gurs/code-lists/:id",
      async (request, reply) =>
        detailRow(
          database,
          reply,
          "SELECT * FROM gurs_etn_code_lists WHERE record_key = $1",
          [request.params.id],
        ),
    );

    app.get<{ Querystring: QueryParameters }>(
      "/gurs/search",
      async (request) => {
        assertKnownFilters(request.query, ["q"]);
        const q = singleQueryValue(request.query, "q")?.trim();
        if (!q) throw new ApiValidationError("q is required");
        const page = parsePage(request.query);
        const values: unknown[] = [q];
        const cursorClause = page.cursor
          ? `WHERE search_key > ${addValue(values, page.cursor)}`
          : "";
        const limit = addValue(values, page.limit + 1);
        const result = (await database.query(
          `
            WITH matches AS (
              SELECT
                'address' AS kind,
                eid_hisna_stevilka AS id,
                full_address AS label,
                '/gurs/addresses/' || eid_hisna_stevilka AS href
              FROM gurs_kn_addresses
              WHERE full_address % $1 OR full_address ILIKE '%' || $1 || '%'
              UNION ALL
              SELECT
                'cadastral', eid_katastrska_obcina, ko_id || ' ' || name,
                '/gurs/cadastral-municipalities/' || eid_katastrska_obcina
              FROM gurs_kn_cadastral_municipalities
              WHERE name % $1 OR name ILIKE '%' || $1 || '%' OR ko_id::text = $1
              UNION ALL
              SELECT
                'parcel', eid_parcela, ko_id || ' ' || parcel_number,
                '/gurs/parcels/' || eid_parcela
              FROM gurs_kn_parcels
              WHERE parcel_number = $1
                 OR (ko_id::text || ' ' || parcel_number) ILIKE '%' || $1 || '%'
              UNION ALL
              SELECT
                'building', eid_stavba, ko_id || ' stavba ' || building_number,
                '/gurs/buildings/' || eid_stavba
              FROM gurs_kn_buildings
              WHERE building_number::text = $1
                 OR (ko_id::text || ' ' || building_number) ILIKE '%' || $1 || '%'
            ),
            keyed AS (
              SELECT *, kind || ':' || id AS search_key FROM matches
            )
            SELECT * FROM keyed
            ${cursorClause}
            ORDER BY search_key
            LIMIT ${limit}
          `,
          values,
        )) as QueryResult<Record<string, unknown>>;
        const hasMore = result.rows.length > page.limit;
        const rows = result.rows.slice(0, page.limit);
        return {
          items: rows.map((row) => serializeRow(row)),
          page: {
            nextCursor:
              hasMore && rows.length
                ? encodeCursor(String(rows.at(-1)?.search_key))
                : null,
            hasMore,
          },
        };
      },
    );
  };
}
