CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE gurs_etn_building_parts
  ADD COLUMN IF NOT EXISTS eid_del_stavbe text;
ALTER TABLE gurs_etn_land
  ADD COLUMN IF NOT EXISTS eid_parcela text;

CREATE INDEX IF NOT EXISTS gurs_etn_building_parts_eid_del_stavbe_idx
  ON gurs_etn_building_parts (eid_del_stavbe);
CREATE INDEX IF NOT EXISTS gurs_etn_land_eid_parcela_idx
  ON gurs_etn_land (eid_parcela);
CREATE INDEX IF NOT EXISTS gurs_kn_addresses_full_address_trgm_idx
  ON gurs_kn_addresses USING gist (full_address gist_trgm_ops);
CREATE INDEX IF NOT EXISTS gurs_kn_cadastral_name_trgm_idx
  ON gurs_kn_cadastral_municipalities USING gist (name gist_trgm_ops);
CREATE INDEX IF NOT EXISTS gurs_kn_building_parts_address_trgm_idx
  ON gurs_kn_building_parts USING gist (address gist_trgm_ops);

CREATE SCHEMA IF NOT EXISTS map;

CREATE TABLE IF NOT EXISTS map.properties (
  eid_stavba text PRIMARY KEY,
  ko_id integer NOT NULL,
  building_number integer NOT NULL,
  full_address text,
  construction_year integer,
  building_type_code integer,
  gross_floor_area double precision,
  pin geometry(Point, 4326),
  footprint geometry(Geometry, 4326)
);

CREATE TABLE IF NOT EXISTS map.sales (
  sale_id text PRIMARY KEY,
  transaction_id text NOT NULL,
  item_kind text NOT NULL CHECK (item_kind IN ('building_part', 'land')),
  entity_id text,
  ko_id integer,
  property_type integer,
  land_type integer,
  contract_date date,
  total_price double precision,
  geom geometry(Point, 4326)
);

CREATE TABLE IF NOT EXISTS map.parcels (
  eid_parcela text PRIMARY KEY,
  ko_id integer NOT NULL,
  parcel_number text NOT NULL,
  area double precision,
  geom geometry(Geometry, 4326)
);

CREATE TABLE IF NOT EXISTS map.cadastral (
  eid_katastrska_obcina text PRIMARY KEY,
  ko_id integer NOT NULL,
  name text NOT NULL,
  geom geometry(Geometry, 4326)
);

CREATE INDEX IF NOT EXISTS map_properties_pin_gix
  ON map.properties USING gist (pin);
CREATE INDEX IF NOT EXISTS map_properties_footprint_gix
  ON map.properties USING gist (footprint);
CREATE INDEX IF NOT EXISTS map_properties_address_trgm_idx
  ON map.properties USING gist (full_address gist_trgm_ops);
CREATE INDEX IF NOT EXISTS map_sales_geom_gix
  ON map.sales USING gist (geom);
CREATE INDEX IF NOT EXISTS map_sales_contract_date_idx
  ON map.sales (contract_date, sale_id);
CREATE INDEX IF NOT EXISTS map_parcels_geom_gix
  ON map.parcels USING gist (geom);
CREATE INDEX IF NOT EXISTS map_cadastral_geom_gix
  ON map.cadastral USING gist (geom);
CREATE INDEX IF NOT EXISTS map_cadastral_name_trgm_idx
  ON map.cadastral USING gist (name gist_trgm_ops);
