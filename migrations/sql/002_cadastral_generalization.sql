ALTER TABLE map.cadastral
  ADD COLUMN IF NOT EXISTS geom_z8 geometry(Geometry, 4326);

CREATE INDEX IF NOT EXISTS map_cadastral_geom_z8_gix
  ON map.cadastral USING gist (geom_z8);
