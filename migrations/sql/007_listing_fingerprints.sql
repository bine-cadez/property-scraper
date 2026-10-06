-- Cross-source grouping for sale and rent ads. scraped_at is the time this
-- row was last retrieved; last_seen_at remains the import clock as well.
ALTER TABLE public.property_listings
  ADD COLUMN IF NOT EXISTS content_fingerprint text,
  ADD COLUMN IF NOT EXISTS duplicate_of text,
  ADD COLUMN IF NOT EXISTS scraped_at timestamptz;

UPDATE public.property_listings
SET scraped_at = last_seen_at
WHERE scraped_at IS NULL;

ALTER TABLE public.property_listings
  DROP CONSTRAINT IF EXISTS property_listings_duplicate_of_check;

ALTER TABLE public.property_listings
  ADD CONSTRAINT property_listings_duplicate_of_check
    CHECK (duplicate_of IS NULL OR duplicate_of <> id);

CREATE INDEX IF NOT EXISTS idx_property_listings_fingerprint
  ON public.property_listings (transaction_type, content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;
