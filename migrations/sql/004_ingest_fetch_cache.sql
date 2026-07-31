CREATE TABLE IF NOT EXISTS public.gurs_ingest_fetch_cache (
  run_key text NOT NULL,
  request_hash text NOT NULL,
  request_url text NOT NULL,
  response jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_key, request_hash)
);

CREATE INDEX IF NOT EXISTS gurs_ingest_fetch_cache_fetched_at_idx
  ON public.gurs_ingest_fetch_cache (fetched_at);
