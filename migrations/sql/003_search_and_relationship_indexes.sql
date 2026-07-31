CREATE INDEX IF NOT EXISTS map_sales_transaction_id_idx
  ON map.sales (transaction_id);

CREATE INDEX IF NOT EXISTS gurs_source_dataset_name_trgm_idx
  ON gurs_source_retrievals USING gist (dataset_name gist_trgm_ops);
CREATE INDEX IF NOT EXISTS gurs_etn_code_description_trgm_idx
  ON gurs_etn_code_lists USING gist (description gist_trgm_ops);
CREATE INDEX IF NOT EXISTS gurs_kn_building_type_name_trgm_idx
  ON gurs_kn_buildings USING gist (building_type_name gist_trgm_ops);
CREATE INDEX IF NOT EXISTS gurs_kn_part_actual_use_name_trgm_idx
  ON gurs_kn_building_parts USING gist (actual_use_name gist_trgm_ops);
