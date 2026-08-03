ALTER TABLE map.properties
  ADD COLUMN IF NOT EXISTS modelled_value double precision;

ALTER TABLE map.parcels
  ADD COLUMN IF NOT EXISTS modelled_value double precision;
