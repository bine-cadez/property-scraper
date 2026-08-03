import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";

import {
  ApiValidationError,
  parseNumberFilter,
  singleQueryValue,
  type QueryParameters,
} from "../gurs/query.js";

type TileLayer = "properties" | "sales" | "parcels" | "cadastral";
type TileParameters = { layer: string; z: string; x: string; y: string };
type QueryResult = { rows: Array<{ tile: Buffer | null }> };

function tileCoordinates(params: TileParameters): {
  layer: TileLayer;
  z: number;
  x: number;
  y: number;
} {
  const layers = new Set<TileLayer>([
    "properties",
    "sales",
    "parcels",
    "cadastral",
  ]);
  if (!layers.has(params.layer as TileLayer)) {
    throw new ApiValidationError("Unknown map layer");
  }
  const z = Number(params.z);
  const x = Number(params.x);
  const y = Number(params.y);
  if (
    !Number.isInteger(z) ||
    z < 0 ||
    z > 22 ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** z ||
    y >= 2 ** z
  ) {
    throw new ApiValidationError("Tile coordinates are out of range");
  }
  return { layer: params.layer as TileLayer, z, x, y };
}

function mapFilters(
  layer: TileLayer,
  query: QueryParameters,
  values: unknown[],
): string {
  const definitions: Record<
    TileLayer,
    Record<string, { column: string; type: "exact" | "min" | "max" | "dateMin" | "dateMax" }>
  > = {
    properties: {
      koId: { column: "feature.ko_id", type: "exact" },
      buildingTypeCode: {
        column: "feature.building_type_code",
        type: "exact",
      },
      constructionYearMin: {
        column: "feature.construction_year",
        type: "min",
      },
      constructionYearMax: {
        column: "feature.construction_year",
        type: "max",
      },
      valuationValueMin: {
        column: "feature.modelled_value",
        type: "min",
      },
      valuationValueMax: {
        column: "feature.modelled_value",
        type: "max",
      },
    },
    sales: {
      itemKind: { column: "feature.item_kind", type: "exact" },
      transactionId: {
        column: "feature.transaction_id",
        type: "exact",
      },
      propertyType: { column: "feature.property_type", type: "exact" },
      landType: { column: "feature.land_type", type: "exact" },
      priceMin: { column: "feature.total_price", type: "min" },
      priceMax: { column: "feature.total_price", type: "max" },
      contractDateMin: {
        column: "feature.contract_date",
        type: "dateMin",
      },
      contractDateMax: {
        column: "feature.contract_date",
        type: "dateMax",
      },
    },
    parcels: {
      koId: { column: "feature.ko_id", type: "exact" },
      areaMin: { column: "feature.area", type: "min" },
      areaMax: { column: "feature.area", type: "max" },
      valuationValueMin: {
        column: "feature.modelled_value",
        type: "min",
      },
      valuationValueMax: {
        column: "feature.modelled_value",
        type: "max",
      },
    },
    cadastral: {
      koId: { column: "feature.ko_id", type: "exact" },
    },
  };
  const definition = definitions[layer];
  const unknown = Object.keys(query).filter((key) => !(key in definition));
  if (unknown.length) {
    throw new ApiValidationError(`Unknown filter: ${unknown.join(", ")}`);
  }
  const clauses: string[] = [];
  for (const [name, filter] of Object.entries(definition)) {
    const raw = singleQueryValue(query, name);
    if (raw === undefined) continue;
    let value: string | number = raw;
    let operator = "=";
    if (filter.type === "min" || filter.type === "max") {
      value = parseNumberFilter(raw, name);
      operator = filter.type === "min" ? ">=" : "<=";
    } else if (filter.type === "dateMin" || filter.type === "dateMax") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        throw new ApiValidationError(`${name} must use YYYY-MM-DD`);
      }
      operator = filter.type === "dateMin" ? ">=" : "<=";
    }
    values.push(value);
    clauses.push(`${filter.column} ${operator} $${values.length}`);
  }
  return clauses.length ? `AND ${clauses.join(" AND ")}` : "";
}

function individualPointSql(
  table: "properties" | "sales",
  id: string,
  attributes: string,
  filters: string,
): string {
  const geometry = table === "properties" ? "pin" : "geom";
  return `
    WITH bounds AS (
      SELECT ST_TileEnvelope($1, $2, $3) AS geom
    ),
    features AS (
      SELECT
        feature.${id}::text AS id,
        hashtextextended(feature.${id}::text, 0) AS feature_id,
        ${attributes},
        'pin'::text AS feature_type,
        ST_AsMVTGeom(
          ST_Transform(feature.${geometry}, 3857),
          bounds.geom,
          4096,
          64,
          true
        ) AS geom
      FROM map.${table} AS feature
      CROSS JOIN bounds
      WHERE
        feature.${geometry} IS NOT NULL
        AND feature.${geometry} && ST_Transform(bounds.geom, 4326)
        ${filters}
    )
    SELECT ST_AsMVT(features, '${table}', 4096, 'geom', 'feature_id') AS tile
    FROM features
  `;
}

function clusteredPointSql(
  table: "properties" | "sales",
  id: string,
  filters: string,
): string {
  const geometry = table === "properties" ? "pin" : "geom";
  return `
    WITH bounds AS (
      SELECT ST_TileEnvelope($1, $2, $3) AS geom
    ),
    grouped AS (
      SELECT
        min(feature.${id}::text) AS id,
        count(*)::int AS cluster_count,
        ST_Centroid(ST_Collect(ST_Transform(feature.${geometry}, 3857))) AS point
      FROM map.${table} AS feature
      CROSS JOIN bounds
      WHERE
        feature.${geometry} IS NOT NULL
        AND feature.${geometry} && ST_Transform(bounds.geom, 4326)
        ${filters}
      GROUP BY ST_SnapToGrid(
        ST_Transform(feature.${geometry}, 3857),
        40075016.68557849 / power(2, $1) / 16
      )
    ),
    features AS (
      SELECT
        grouped.id,
        hashtextextended(grouped.id, 0) AS feature_id,
        grouped.cluster_count,
        'cluster'::text AS feature_type,
        ST_AsMVTGeom(grouped.point, bounds.geom, 4096, 64, true) AS geom
      FROM grouped
      CROSS JOIN bounds
    )
    SELECT ST_AsMVT(features, '${table}', 4096, 'geom', 'feature_id') AS tile
    FROM features
  `;
}

function propertyPinsAndFootprintsSql(filters: string): string {
  return `
    WITH bounds AS (
      SELECT ST_TileEnvelope($1, $2, $3) AS geom
    ),
    source_features AS (
      SELECT
        feature.eid_stavba::text AS id,
        feature.ko_id,
        feature.building_number,
        feature.full_address,
        feature.construction_year,
        feature.building_type_code,
        feature.gross_floor_area,
        feature.modelled_value,
        'pin'::text AS feature_type,
        ST_Transform(feature.pin, 3857) AS map_geometry
      FROM map.properties AS feature
      CROSS JOIN bounds
      WHERE
        feature.pin IS NOT NULL
        AND feature.pin && ST_Transform(bounds.geom, 4326)
        ${filters}

      UNION ALL

      SELECT
        feature.eid_stavba::text AS id,
        feature.ko_id,
        feature.building_number,
        feature.full_address,
        feature.construction_year,
        feature.building_type_code,
        feature.gross_floor_area,
        feature.modelled_value,
        'footprint'::text AS feature_type,
        ST_Transform(feature.footprint, 3857) AS map_geometry
      FROM map.properties AS feature
      CROSS JOIN bounds
      WHERE
        feature.footprint IS NOT NULL
        AND feature.footprint && ST_Transform(bounds.geom, 4326)
        ${filters}
    ),
    features AS (
      SELECT
        source_features.id,
        hashtextextended(
          source_features.id || ':' || source_features.feature_type,
          0
        ) AS feature_id,
        source_features.ko_id,
        source_features.building_number,
        source_features.full_address,
        source_features.construction_year,
        source_features.building_type_code,
        source_features.gross_floor_area,
        source_features.modelled_value,
        source_features.feature_type,
        ST_AsMVTGeom(
          source_features.map_geometry,
          bounds.geom,
          4096,
          64,
          true
        ) AS geom
      FROM source_features
      CROSS JOIN bounds
    )
    SELECT ST_AsMVT(features, 'properties', 4096, 'geom', 'feature_id') AS tile
    FROM features
  `;
}

function polygonSql(
  layer: "parcels" | "cadastral",
  id: string,
  attributes: string,
  filters: string,
): string {
  const tileGeometry =
    layer === "cadastral"
      ? "CASE WHEN $1 <= 11 THEN feature.geom_z8 ELSE feature.geom END"
      : `
        ST_SimplifyPreserveTopology(
          feature.geom,
          360.0 / power(2, $1) / 2048
        )
      `;

  return `
    WITH bounds AS (
      SELECT ST_TileEnvelope($1, $2, $3) AS geom
    ),
    features AS (
      SELECT
        feature.${id}::text AS id,
        hashtextextended(feature.${id}::text, 0) AS feature_id,
        ${attributes},
        ST_AsMVTGeom(
          ST_Transform(
            ${tileGeometry},
            3857
          ),
          bounds.geom,
          4096,
          16,
          true
        ) AS geom
      FROM map.${layer} AS feature
      CROSS JOIN bounds
      WHERE
        feature.geom IS NOT NULL
        AND feature.geom && ST_Transform(bounds.geom, 4326)
        ${filters}
    )
    SELECT ST_AsMVT(features, '${layer}', 4096, 'geom', 'feature_id') AS tile
    FROM features
  `;
}

export function mapRoutes(database: Pool): FastifyPluginAsync {
  return async (app) => {
    app.get<{
      Params: TileParameters;
      Querystring: QueryParameters;
    }>("/map/tiles/:layer/:z/:x/:y.mvt", async (request, reply) => {
      const { layer, z, x, y } = tileCoordinates(request.params);
      const values: unknown[] = [z, x, y];
      const filters = mapFilters(layer, request.query, values);
      let sql: string | null = null;

      if (layer === "properties") {
        sql =
          z <= 11
            ? clusteredPointSql("properties", "eid_stavba", filters)
            : z >= 16
              ? propertyPinsAndFootprintsSql(filters)
              : individualPointSql(
                "properties",
                "eid_stavba",
                `
                  feature.ko_id,
                  feature.building_number,
                  feature.full_address,
                  feature.construction_year,
                  feature.building_type_code,
                  feature.gross_floor_area,
                  feature.modelled_value
                `,
                filters,
                );
      } else if (layer === "sales") {
        sql =
          z <= 11
            ? clusteredPointSql("sales", "sale_id", filters)
            : individualPointSql(
                "sales",
                "sale_id",
                `
                  feature.transaction_id,
                  feature.item_kind,
                  feature.entity_id,
                  feature.ko_id,
                  feature.property_type,
                  feature.land_type,
                  feature.contract_date,
                  feature.total_price
                `,
                filters,
              );
      } else if (layer === "parcels" && z >= 15) {
        sql = polygonSql(
          "parcels",
          "eid_parcela",
          "feature.ko_id, feature.parcel_number, feature.area, feature.modelled_value",
          filters,
        );
      } else if (layer === "cadastral" && z >= 8) {
        sql = polygonSql(
          "cadastral",
          "eid_katastrska_obcina",
          "feature.ko_id, feature.name",
          filters,
        );
      }

      if (!sql) {
        return reply
          .type("application/vnd.mapbox-vector-tile")
          .send(Buffer.alloc(0));
      }

      const result = (await database.query(sql, values)) as QueryResult;
      const tile = result.rows[0]?.tile ?? Buffer.alloc(0);

      return reply
        .type("application/vnd.mapbox-vector-tile")
        .header("cache-control", "private, max-age=300")
        .send(tile);
    });
  };
}
