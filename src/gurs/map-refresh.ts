type Queryable = {
  query(text: string, values?: unknown[]): Promise<unknown>;
};

/**
 * Rebuilds all derived spatial data in the caller's transaction. Source
 * coordinates are Slovenian national grid (EPSG:3794); GeoJSON returned by
 * the OGC APIs is already CRS84/WGS84.
 */
export async function refreshMapTables(database: Queryable): Promise<void> {
  await database.query(
    "TRUNCATE map.properties, map.sales, map.parcels, map.cadastral",
  );

  await database.query(`
    INSERT INTO map.properties (
      eid_stavba, ko_id, building_number, full_address, construction_year,
      building_type_code, gross_floor_area, pin, footprint
    )
    SELECT
      building.eid_stavba,
      building.ko_id,
      building.building_number,
      address.full_address,
      building.construction_year,
      building.building_type_code,
      building.gross_floor_area::double precision,
      COALESCE(
        CASE
          WHEN building.centroid_e IS NOT NULL AND building.centroid_n IS NOT NULL
          THEN ST_Transform(
            ST_SetSRID(
              ST_MakePoint(
                building.centroid_e::double precision,
                building.centroid_n::double precision
              ),
              3794
            ),
            4326
          )::geometry(Point, 4326)
        END,
        ST_PointOnSurface(
          ST_SetSRID(ST_GeomFromGeoJSON(building.footprint_geometry), 4326)
        )::geometry(Point, 4326)
      ),
      CASE
        WHEN building.footprint_geometry IS NOT NULL
        THEN ST_SetSRID(
          ST_GeomFromGeoJSON(building.footprint_geometry),
          4326
        )
      END
    FROM public.gurs_kn_buildings AS building
    LEFT JOIN LATERAL (
      SELECT full_address
      FROM public.gurs_kn_addresses
      WHERE eid_stavba = building.eid_stavba
      ORDER BY eid_hisna_stevilka
      LIMIT 1
    ) AS address ON true
    WHERE
      (building.centroid_e IS NOT NULL AND building.centroid_n IS NOT NULL)
      OR building.footprint_geometry IS NOT NULL
  `);

  await database.query(`
    INSERT INTO map.sales (
      sale_id, transaction_id, item_kind, entity_id, ko_id, property_type,
      land_type, contract_date, total_price, geom
    )
    SELECT
      item.record_key,
      item.id_posla::text,
      'building_part',
      item.eid_del_stavbe,
      item.ko_id,
      item.property_type,
      NULL,
      transaction.contract_date,
      transaction.total_price::double precision,
      ST_Transform(
        ST_SetSRID(
          ST_MakePoint(
            item.centroid_e::double precision,
            item.centroid_n::double precision
          ),
          3794
        ),
        4326
      )::geometry(Point, 4326)
    FROM public.gurs_etn_building_parts AS item
    JOIN public.gurs_etn_transactions AS transaction USING (id_posla)
    WHERE item.centroid_e IS NOT NULL AND item.centroid_n IS NOT NULL

    UNION ALL

    SELECT
      item.record_key,
      item.id_posla::text,
      'land',
      item.eid_parcela,
      item.ko_id,
      NULL,
      item.land_type,
      transaction.contract_date,
      transaction.total_price::double precision,
      ST_Transform(
        ST_SetSRID(
          ST_MakePoint(
            item.centroid_e::double precision,
            item.centroid_n::double precision
          ),
          3794
        ),
        4326
      )::geometry(Point, 4326)
    FROM public.gurs_etn_land AS item
    JOIN public.gurs_etn_transactions AS transaction USING (id_posla)
    WHERE item.centroid_e IS NOT NULL AND item.centroid_n IS NOT NULL
  `);

  await database.query(`
    INSERT INTO map.parcels (eid_parcela, ko_id, parcel_number, area, geom)
    SELECT
      eid_parcela,
      ko_id,
      parcel_number,
      area::double precision,
      ST_SetSRID(ST_GeomFromGeoJSON(geometry), 4326)
    FROM public.gurs_kn_parcels
    WHERE geometry IS NOT NULL
  `);

  await database.query(`
    WITH source AS (
      SELECT
        eid_katastrska_obcina,
        ko_id,
        name,
        ST_SetSRID(ST_GeomFromGeoJSON(geometry), 4326) AS geom
      FROM public.gurs_kn_cadastral_municipalities
      WHERE geometry IS NOT NULL
    )
    INSERT INTO map.cadastral (
      eid_katastrska_obcina, ko_id, name, geom, geom_z8
    )
    SELECT
      eid_katastrska_obcina,
      ko_id,
      name,
      geom,
      ST_SimplifyPreserveTopology(geom, 360.0 / 256 / 1024)
    FROM source
  `);
}
