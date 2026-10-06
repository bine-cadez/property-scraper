-- Advertisement inventory is independent of GURS recorded transactions.
-- Deployment runs SQL migrations directly, so this table can be bootstrapped
-- without requiring the development-only Kyrage CLI.
CREATE TABLE IF NOT EXISTS public.property_listings (
  id text PRIMARY KEY,
  source text NOT NULL,
  source_listing_id text NOT NULL,
  url text NOT NULL,
  transaction_type text NOT NULL,
  property_type text NOT NULL,
  title text NOT NULL,
  description text,
  location_text text,
  address text,
  price numeric,
  currency text NOT NULL DEFAULT 'EUR',
  price_unit text NOT NULL DEFAULT 'unknown',
  area_m2 numeric,
  land_area_m2 numeric,
  rooms numeric,
  latitude double precision,
  longitude double precision,
  location_accuracy text NOT NULL DEFAULT 'unknown',
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT uq_property_listings_source_source_listing_id_transaction_type
    UNIQUE (source, source_listing_id, transaction_type)
);

ALTER TABLE public.property_listings
  ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326)
    GENERATED ALWAYS AS (
      CASE
        WHEN longitude IS NULL OR latitude IS NULL THEN NULL
        ELSE ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
      END
    ) STORED,
  ADD CONSTRAINT property_listings_transaction_type_check
    CHECK (transaction_type IN ('sale', 'rent')),
  ADD CONSTRAINT property_listings_property_type_check
    CHECK (property_type IN ('house', 'apartment', 'land', 'commercial', 'garage', 'other')),
  ADD CONSTRAINT property_listings_price_unit_check
    CHECK (price_unit IN ('total', 'month', 'week', 'day', 'm2', 'unknown')),
  ADD CONSTRAINT property_listings_location_accuracy_check
    CHECK (location_accuracy IN ('exact', 'approximate', 'unknown')),
  ADD CONSTRAINT property_listings_coordinates_check
    CHECK (
      (latitude IS NULL AND longitude IS NULL)
      OR (
        latitude IS NOT NULL AND longitude IS NOT NULL
        AND latitude BETWEEN -90 AND 90
        AND longitude BETWEEN -180 AND 180
      )
    ),
  ADD CONSTRAINT property_listings_identity_check
    CHECK (
      source <> '' AND source_listing_id <> ''
      AND id = source || ':' || transaction_type || ':' || source_listing_id
    ),
  ADD CONSTRAINT property_listings_images_check
    CHECK (jsonb_typeof(images) = 'array'),
  ADD CONSTRAINT property_listings_amounts_check
    CHECK (
      (price IS NULL OR price >= 0)
      AND (area_m2 IS NULL OR area_m2 >= 0)
      AND (land_area_m2 IS NULL OR land_area_m2 >= 0)
      AND (rooms IS NULL OR rooms >= 0)
    );

CREATE INDEX IF NOT EXISTS idx_property_listings_transaction_type_active_id
  ON public.property_listings (transaction_type, active, id);
CREATE INDEX IF NOT EXISTS idx_property_listings_source_last_seen_at
  ON public.property_listings (source, last_seen_at);
CREATE INDEX IF NOT EXISTS property_listings_geom_gist
  ON public.property_listings USING GIST (geom) WHERE active AND geom IS NOT NULL;
