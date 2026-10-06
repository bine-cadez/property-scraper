import type { FastifyPluginAsync, FastifySchema } from "fastify";
import type { Pool } from "pg";

import {
  ApiValidationError,
  encodeCursor,
  parseBbox,
  parsePage,
  serializeRow,
  singleQueryValue,
  type QueryParameters,
} from "../gurs/query.js";
import { listingSources } from "../listings/sources/index.js";

type ListingLayer = "sales" | "rentals";
type TileParameters = { layer: string; z: string; x: string; y: string };
type ListingRow = Record<string, unknown> & { id: string };

const propertyTypes = ["house", "apartment", "land", "commercial", "garage", "other"];
const priceUnits = ["total", "month", "week", "day", "m2", "unknown"];
const numericFields = new Set(["price", "area_m2", "land_area_m2", "rooms", "latitude", "longitude"]);
const columns = `
  feature.id, feature.source, feature.source_listing_id, feature.url,
  feature.transaction_type, feature.property_type, feature.title,
  feature.description, feature.location_text, feature.address, feature.price,
  feature.currency, feature.price_unit, feature.area_m2, feature.land_area_m2,
  feature.rooms, feature.latitude, feature.longitude, feature.location_accuracy,
  feature.images, feature.first_seen_at, feature.last_seen_at, feature.updated_at,
  feature.active
`;

const filterProperties = {
  source: { type: "string", minLength: 1, maxLength: 64, description: "A source key from /listings/sources." },
  propertyType: { type: "string", enum: propertyTypes, description: "The advertised property category." },
  priceUnit: { type: "string", enum: priceUnits, description: "The price basis. Required when using priceMin or priceMax; a monthly rent, total price, and price per square metre are separate amounts." },
  priceMin: { type: "string", description: "Minimum asking price in the selected priceUnit, in EUR." },
  priceMax: { type: "string", description: "Maximum asking price in the selected priceUnit, in EUR." },
  areaMin: { type: "string", description: "Minimum advertised floor/property area in square metres." },
  areaMax: { type: "string", description: "Maximum advertised floor/property area in square metres." },
  bbox: { type: "string", description: "WGS84 bounding box as minLon,minLat,maxLon,maxLat. Listings without coordinates are excluded when this filter is used." },
};

const listQuerySchema = {
  type: "object",
  // Validate unknown keys in the handler: Fastify otherwise removes them.
  additionalProperties: true,
  properties: {
    ...filterProperties,
    active: { type: "string", enum: ["true", "false", "all"], description: "Defaults to true (active ads). Use false for inactive ads or all for both." },
    limit: { type: "string", description: "Page size, from 1 to 200. Defaults to 50." },
    cursor: { type: "string", minLength: 1, maxLength: 4096, description: "The opaque nextCursor returned by the preceding page." },
  },
};

function routeSchema(summary: string, description: string): FastifySchema {
  return { tags: ["Listings"], summary, description, security: [{ apiKey: [] }] };
}

function assertFilters(query: QueryParameters, pagination: boolean): void {
  const allowed = new Set([
    ...Object.keys(filterProperties),
    ...(pagination ? ["active", "limit", "cursor"] : []),
  ]);
  const unknown = Object.keys(query).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new ApiValidationError(`Unknown filter: ${unknown.join(", ")}`);
  }
}

function addValue(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

function amount(value: string, name: string): number {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) {
    throw new ApiValidationError(`${name} must be a non-negative number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiValidationError(`${name} must be a non-negative number`);
  }
  return parsed;
}

function listingFilters(
  query: QueryParameters,
  values: unknown[],
  pagination: boolean,
): string[] {
  assertFilters(query, pagination);
  const clauses: string[] = [];
  if (pagination) {
    const active = singleQueryValue(query, "active") ?? "true";
    if (active !== "all") {
      if (active !== "true" && active !== "false") {
        throw new ApiValidationError("active must be true, false, or all");
      }
      clauses.push(`feature.active = ${addValue(values, active === "true")}`);
    }
  } else {
    clauses.push("feature.active = true");
  }

  const source = singleQueryValue(query, "source");
  if (source !== undefined) {
    if (!listingSources.some((candidate) => candidate.key === source)) {
      throw new ApiValidationError("source must be a key from /listings/sources");
    }
    clauses.push(`feature.source = ${addValue(values, source)}`);
  }
  for (const [name, column, allowed] of [
    ["propertyType", "property_type", propertyTypes],
    ["priceUnit", "price_unit", priceUnits],
  ] as const) {
    const value = singleQueryValue(query, name);
    if (value === undefined) continue;
    if (!allowed.includes(value)) throw new ApiValidationError(`${name} is invalid`);
    clauses.push(`feature.${column} = ${addValue(values, value)}`);
  }

  const ranges: Array<[string, string, string]> = [
    ["price", "price", "priceUnit"],
    ["area", "area_m2", ""],
  ];
  for (const [name, column, requiredUnit] of ranges) {
    const rawMin = singleQueryValue(query, `${name}Min`);
    const rawMax = singleQueryValue(query, `${name}Max`);
    if (requiredUnit && (rawMin !== undefined || rawMax !== undefined)
      && singleQueryValue(query, requiredUnit) === undefined) {
      throw new ApiValidationError("priceUnit is required when filtering by priceMin or priceMax");
    }
    const min = rawMin === undefined ? undefined : amount(rawMin, `${name}Min`);
    const max = rawMax === undefined ? undefined : amount(rawMax, `${name}Max`);
    if (min !== undefined && max !== undefined && min > max) {
      throw new ApiValidationError(`${name}Min must not exceed ${name}Max`);
    }
    if (min !== undefined) clauses.push(`feature.${column} >= ${addValue(values, min)}`);
    if (max !== undefined) clauses.push(`feature.${column} <= ${addValue(values, max)}`);
  }

  const bbox = singleQueryValue(query, "bbox");
  if (bbox !== undefined) {
    if (bbox.split(",").some((coordinate) => coordinate.trim() === "")) {
      throw new ApiValidationError("bbox must contain minLon,minLat,maxLon,maxLat");
    }
    const coordinates = parseBbox(bbox).map((coordinate) => addValue(values, coordinate));
    clauses.push(`feature.geom && ST_MakeEnvelope(${coordinates.join(", ")}, 4326)`);
  }
  return clauses;
}

function tileCoordinates(params: TileParameters): {
  layer: ListingLayer; z: number; x: number; y: number;
} {
  if (params.layer !== "sales" && params.layer !== "rentals") {
    throw new ApiValidationError("Unknown listing map layer");
  }
  const [z, x, y] = [params.z, params.x, params.y].map(Number) as [number, number, number];
  if (!Number.isInteger(z) || z < 0 || z > 22
    || !Number.isInteger(x) || !Number.isInteger(y)
    || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    throw new ApiValidationError("Tile coordinates are out of range");
  }
  return { layer: params.layer, z, x, y };
}

function listingTileSql(layer: ListingLayer, clustered: boolean, filters: string[]): string {
  const bounds = `
    feature.geom IS NOT NULL
    AND feature.geom && ST_Transform(bounds.geom, 4326)
    AND feature.transaction_type = $4
    AND ${filters.join(" AND ")}
  `;
  if (clustered) {
    return `
      WITH bounds AS (SELECT ST_TileEnvelope($1, $2, $3) AS geom),
      grouped AS (
        SELECT min(feature.id) AS id, count(*)::int AS cluster_count,
          ST_Centroid(ST_Collect(ST_Transform(feature.geom, 3857))) AS point
        FROM public.property_listings AS feature CROSS JOIN bounds
        WHERE ${bounds}
        GROUP BY ST_SnapToGrid(
          ST_Transform(feature.geom, 3857),
          40075016.68557849 / power(2, $1) / 16
        )
      ),
      features AS (
        SELECT grouped.id,
          (hashtextextended(grouped.id, 0) & 9223372036854775807::bigint) AS feature_id,
          grouped.cluster_count, 'cluster'::text AS feature_type,
          ST_AsMVTGeom(grouped.point, bounds.geom, 4096, 64, true) AS geom
        FROM grouped CROSS JOIN bounds
      )
      SELECT ST_AsMVT(features, 'listing_${layer}', 4096, 'geom', 'feature_id') AS tile
      FROM features
    `;
  }
  return `
    WITH bounds AS (SELECT ST_TileEnvelope($1, $2, $3) AS geom),
    features AS (
      SELECT feature.id,
        (hashtextextended(feature.id, 0) & 9223372036854775807::bigint) AS feature_id,
        feature.source, feature.url, feature.price::double precision AS asking_price,
        feature.currency, feature.price_unit, feature.property_type, feature.location_accuracy,
        'pin'::text AS feature_type,
        ST_AsMVTGeom(ST_Transform(feature.geom, 3857), bounds.geom, 4096, 64, true) AS geom
      FROM public.property_listings AS feature CROSS JOIN bounds
      WHERE ${bounds}
    )
    SELECT ST_AsMVT(features, 'listing_${layer}', 4096, 'geom', 'feature_id') AS tile
    FROM features
  `;
}

export function listingRoutes(database: Pool): FastifyPluginAsync {
  return async (app) => {
    app.get("/listings/sources", {
      schema: routeSchema(
        "See available advertisement sources",
        "Returns source keys, priorities, and adapter availability. A disabled source is a candidate and does not contribute ads to automatic imports.",
      ),
    }, async () => ({ items: listingSources }));

    for (const [layer, transaction] of [["sales", "sale"], ["rentals", "rent"]] as const) {
      app.get<{ Querystring: QueryParameters }>(`/listings/${layer}`, {
        schema: {
          ...routeSchema(
            `Browse property ads for ${transaction === "sale" ? "sale" : "rent"}`,
            "Returns saved advertisements ordered by their stable ID, with asking prices and location accuracy. Ads without coordinates remain available here. Prices are advertised amounts; use priceUnit with any price range. Active ads are returned by default.",
          ),
          querystring: listQuerySchema,
        },
      }, async (request) => {
        const values: unknown[] = [transaction];
        const clauses = ["feature.transaction_type = $1", ...listingFilters(request.query, values, true)];
        const rawLimit = singleQueryValue(request.query, "limit");
        if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) {
          throw new ApiValidationError("limit must be an integer between 1 and 200");
        }
        const page = parsePage(request.query);
        if (page.cursor) clauses.push(`feature.id > ${addValue(values, page.cursor)}`);
        const limit = addValue(values, page.limit + 1);
        const result = await database.query<ListingRow>(`
          SELECT ${columns} FROM public.property_listings AS feature
          WHERE ${clauses.join(" AND ")}
          ORDER BY feature.id ASC LIMIT ${limit}
        `, values);
        const hasMore = result.rows.length > page.limit;
        const rows = result.rows.slice(0, page.limit);
        const last = rows.at(-1);
        return {
          items: rows.map((row) => serializeRow(row, numericFields)),
          page: { hasMore, nextCursor: hasMore && last ? encodeCursor(last.id) : null },
        };
      });

      app.get<{ Params: { id: string }; Querystring: QueryParameters }>(`/listings/${layer}/:id`, {
        schema: {
          ...routeSchema(
            `View one saved ${transaction === "sale" ? "sale" : "rental"} advertisement`,
            "Returns the saved ad with its original URL, source, asking-price basis, timestamps, and location accuracy. Inactive ads remain accessible by ID. Unknown coordinates are returned as null.",
          ),
          params: { type: "object", required: ["id"], properties: {
            id: { type: "string", minLength: 1, maxLength: 512, description: "Stable advertisement ID, in source:transactionType:sourceListingId form." },
          } },
          querystring: { type: "object", additionalProperties: true, properties: {} },
        },
      }, async (request, reply) => {
        if (Object.keys(request.query).length) throw new ApiValidationError("This endpoint does not accept filters");
        const result = await database.query<ListingRow>(`
          SELECT ${columns} FROM public.property_listings AS feature
          WHERE feature.id = $1 AND feature.transaction_type = $2
        `, [request.params.id, transaction]);
        const row = result.rows[0];
        if (!row) return reply.code(404).send({ message: "Listing not found" });
        return serializeRow(row, numericFields);
      });
    }

    app.get<{ Params: TileParameters; Querystring: QueryParameters }>("/listings/map/tiles/:layer/:z/:x/:y.mvt", {
      schema: {
        ...routeSchema(
          "Load sale or rental advertisement locations for a map",
          "Returns active, located advertisements as Mapbox Vector Tiles. Choose sales for source-layer listing_sales or rentals for listing_rentals. Zooms 0–11 group locations into clusters with cluster_count; zooms 12–22 return individual ads, source URLs, asking prices, price units, and location accuracy. Ads without coordinates remain in the read API and are excluded from tiles.",
        ),
        params: { type: "object", required: ["layer", "z", "x", "y"], properties: {
          layer: { type: "string", enum: ["sales", "rentals"], description: "Sale advertisements or rental advertisements." },
          z: { type: "string", pattern: "^(0|[1-9][0-9]*)$", description: "Map zoom, from 0 to 22." },
          x: { type: "string", pattern: "^(0|[1-9][0-9]*)$", description: "Horizontal tile coordinate, from 0 to 2^z - 1." },
          y: { type: "string", pattern: "^(0|[1-9][0-9]*)$", description: "Vertical tile coordinate, from 0 to 2^z - 1." },
        } },
        querystring: { type: "object", additionalProperties: true, properties: filterProperties },
      },
    }, async (request, reply) => {
      const { layer, z, x, y } = tileCoordinates(request.params);
      const values: unknown[] = [z, x, y, layer === "sales" ? "sale" : "rent"];
      const filters = listingFilters(request.query, values, false);
      const result = await database.query<{ tile: Buffer | null }>(listingTileSql(layer, z <= 11, filters), values);
      return reply.type("application/vnd.mapbox-vector-tile")
        .header("cache-control", "private, max-age=300")
        .send(result.rows[0]?.tile ?? Buffer.alloc(0));
    });
  };
}
