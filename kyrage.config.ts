import "dotenv/config";

import { column, defineConfig, defineTable } from "@izumisy/kyrage";

const sourceRetrievals = defineTable("gurs_source_retrievals", {
  source_key: column("text", { primaryKey: true }),
  dataset_name: column("text", { notNull: true }),
  source_url: column("text", { notNull: true }),
  retrieved_at: column("timestamptz", {
    notNull: true,
    defaultSql: "CURRENT_TIMESTAMP",
  }),
  reference_date: column("date"),
  licence: column("text", { notNull: true }),
  attribution: column("text", { notNull: true }),
  http_status: column("integer", { notNull: true }),
  nationwide: column("boolean", { notNull: true }),
  update_frequency: column("text"),
  metadata: column("jsonb", { notNull: true }),
});

const knParcels = defineTable(
  "gurs_kn_parcels",
  {
    eid_parcela: column("text", { primaryKey: true }),
    ko_id: column("integer", { notNull: true }),
    parcel_number: column("text", { notNull: true }),
    area: column("numeric"),
    centroid_e: column("numeric"),
    centroid_n: column("numeric"),
    geometry: column("jsonb"),
    administrative_status_code: column("integer"),
    administrative_status_name: column("text"),
    land_rating: column("integer"),
    accessibility: column("integer"),
    site_coefficient: column("integer"),
    source_updated_at: column("timestamptz"),
    source_key: column("text", { notNull: true }),
    ev_source_key: column("text"),
  },
  ({ index, unique }) => [
    unique(["ko_id", "parcel_number"]),
    index(["centroid_e", "centroid_n"]),
    index(["source_key"]),
  ],
);

const knBuildings = defineTable(
  "gurs_kn_buildings",
  {
    eid_stavba: column("text", { primaryKey: true }),
    ko_id: column("integer", { notNull: true }),
    building_number: column("integer", { notNull: true }),
    floor_count: column("integer"),
    apartment_count: column("integer"),
    business_premises_count: column("integer"),
    gross_floor_area: column("numeric"),
    construction_year: column("integer"),
    facade_renovation_year: column("integer"),
    roof_renovation_year: column("integer"),
    building_type_code: column("integer"),
    building_type_name: column("text"),
    construction_type_code: column("integer"),
    construction_type_name: column("text"),
    electricity_code: column("integer"),
    gas_code: column("integer"),
    water_code: column("integer"),
    sewer_code: column("integer"),
    centroid_e: column("numeric"),
    centroid_n: column("numeric"),
    footprint_geometry: column("jsonb"),
    source_updated_at: column("timestamptz"),
    source_key: column("text", { notNull: true }),
    ev_source_key: column("text"),
  },
  ({ index, unique }) => [
    unique(["ko_id", "building_number"]),
    index(["centroid_e", "centroid_n"]),
    index(["source_key"]),
  ],
);

const knBuildingParts = defineTable(
  "gurs_kn_building_parts",
  {
    eid_del_stavbe: column("text", { primaryKey: true }),
    eid_stavba: column("text", { notNull: true }),
    eid_hisna_stevilka: column("text"),
    ko_id: column("integer", { notNull: true }),
    building_number: column("integer", { notNull: true }),
    part_number: column("integer", { notNull: true }),
    actual_use_code: column("integer"),
    actual_use_name: column("text"),
    area: column("numeric"),
    useful_area: column("numeric"),
    address: column("text"),
    apartment_number: column("integer"),
    floor_number: column("integer"),
    floor_label: column("text"),
    main_entrance_floor: column("integer"),
    position_code: column("integer"),
    position_name: column("text"),
    elevator_code: column("integer"),
    window_renovation_year: column("integer"),
    installation_renovation_year: column("integer"),
    source_updated_at: column("timestamptz"),
    source_key: column("text", { notNull: true }),
    ev_source_key: column("text"),
  },
  ({ index, unique }) => [
    unique(["ko_id", "building_number", "part_number"]),
    index(["eid_stavba"]),
    index(["eid_hisna_stevilka"]),
    index(["source_key"]),
  ],
);

const knBuildingParcels = defineTable(
  "gurs_kn_building_parcels",
  {
    eid_stavba_parcela: column("text", { primaryKey: true }),
    eid_stavba: column("text", { notNull: true }),
    eid_parcela: column("text", { notNull: true }),
    relationship_type_id: column("integer"),
    area: column("numeric"),
    source_key: column("text", { notNull: true }),
  },
  ({ index }) => [
    index(["eid_stavba"]),
    index(["eid_parcela"]),
    index(["source_key"]),
  ],
);

const knCadastralMunicipalities = defineTable(
  "gurs_kn_cadastral_municipalities",
  {
    eid_katastrska_obcina: column("text", { primaryKey: true }),
    ko_id: column("integer", { notNull: true, unique: true }),
    name: column("text", { notNull: true }),
    geometry: column("jsonb"),
    source_updated_at: column("timestamptz"),
    source_key: column("text", { notNull: true }),
  },
  ({ index }) => [index(["source_key"])],
);

const knAddresses = defineTable(
  "gurs_kn_addresses",
  {
    eid_hisna_stevilka: column("text", { primaryKey: true }),
    eid_stavba: column("text", { notNull: true }),
    municipality_name: column("text"),
    settlement_name: column("text"),
    street_name: column("text"),
    house_number: column("integer", { notNull: true }),
    house_number_suffix: column("text"),
    postal_code: column("integer"),
    postal_name: column("text"),
    full_address: column("text"),
    centroid_e: column("numeric"),
    centroid_n: column("numeric"),
    source_updated_at: column("timestamptz"),
    source_key: column("text", { notNull: true }),
  },
  ({ index }) => [
    index(["eid_stavba"]),
    index(["municipality_name", "settlement_name", "street_name"]),
    index(["centroid_e", "centroid_n"]),
    index(["source_key"]),
  ],
);

const evParcelUnits = defineTable(
  "gurs_ev_parcel_units",
  {
    parcel_unit_id: column("text", { primaryKey: true }),
    eid_parcela: column("text", { notNull: true }),
    valuation_model_id: column("text", { notNull: true }),
    valuation_model_name: column("text"),
    area_share: column("numeric"),
    value_level: column("text"),
    modelled_value: column("numeric", { notNull: true }),
    source_key: column("text", { notNull: true }),
  },
  ({ index }) => [
    index(["eid_parcela"]),
    index(["valuation_model_id"]),
    index(["source_key"]),
  ],
);

const evBuildingPartUnits = defineTable(
  "gurs_ev_building_part_units",
  {
    eid_del_stavbe: column("text", { primaryKey: true }),
    valuation_model_id: column("text", { notNull: true }),
    value_level: column("text"),
    special_circumstance_effect: column("numeric"),
    modelled_value: column("numeric", { notNull: true }),
    source_key: column("text", { notNull: true }),
  },
  ({ index }) => [
    index(["valuation_model_id"]),
    index(["source_key"]),
  ],
);

const etnTransactions = defineTable(
  "gurs_etn_transactions",
  {
    id_posla: column("bigint", { primaryKey: true }),
    transaction_type: column("integer"),
    effective_date: column("date"),
    contract_date: column("date"),
    total_price: column("numeric"),
    includes_vat: column("integer"),
    last_changed_date: column("date"),
    deed_type: column("integer"),
    marketability: column("integer"),
    year: column("integer", { notNull: true }),
    source_key: column("text", { notNull: true }),
  },
  ({ index }) => [
    index(["contract_date"]),
    index(["marketability", "contract_date"]),
    index(["year"]),
    index(["source_key"]),
  ],
);

const etnBuildingParts = defineTable(
  "gurs_etn_building_parts",
  {
    record_key: column("text", { primaryKey: true }),
    id_posla: column("bigint", { notNull: true }),
    ko_id: column("integer"),
    building_number: column("integer"),
    part_number: column("integer"),
    settlement_name: column("text"),
    street_name: column("text"),
    house_number: column("text"),
    property_type: column("integer"),
    construction_year: column("integer"),
    sold_area: column("numeric"),
    sold_share: column("text"),
    actual_use: column("text"),
    area: column("numeric"),
    useful_area: column("numeric"),
    centroid_e: column("numeric"),
    centroid_n: column("numeric"),
    eid_del_stavbe: column("text"),
    year: column("integer", { notNull: true }),
    source_key: column("text", { notNull: true }),
  },
  ({ index }) => [
    index(["id_posla"]),
    index(["ko_id", "building_number", "part_number"]),
    index(["centroid_e", "centroid_n"]),
    index(["year"]),
    index(["source_key"]),
  ],
);

const etnLand = defineTable(
  "gurs_etn_land",
  {
    record_key: column("text", { primaryKey: true }),
    id_posla: column("bigint", { notNull: true }),
    ko_id: column("integer"),
    parcel_number: column("text"),
    land_type: column("integer"),
    sold_share: column("text"),
    parcel_area: column("numeric"),
    centroid_e: column("numeric"),
    centroid_n: column("numeric"),
    eid_parcela: column("text"),
    year: column("integer", { notNull: true }),
    source_key: column("text", { notNull: true }),
  },
  ({ index }) => [
    index(["id_posla"]),
    index(["ko_id", "parcel_number"]),
    index(["centroid_e", "centroid_n"]),
    index(["year"]),
    index(["source_key"]),
  ],
);

const etnCodeLists = defineTable(
  "gurs_etn_code_lists",
  {
    record_key: column("text", { primaryKey: true }),
    code_list_id: column("integer"),
    code_list_name: column("text", { notNull: true }),
    numeric_value: column("integer"),
    description: column("text", { notNull: true }),
    source_key: column("text", { notNull: true }),
  },
  ({ index }) => [
    index(["code_list_name", "numeric_value"]),
    index(["source_key"]),
  ],
);

export default defineConfig({
  database: {
    dialect: "postgres",
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5433/property_scraper",
  },
  tables: [
    sourceRetrievals,
    knParcels,
    knBuildings,
    knBuildingParts,
    knBuildingParcels,
    knCadastralMunicipalities,
    knAddresses,
    evParcelUnits,
    evBuildingPartUnits,
    etnTransactions,
    etnBuildingParts,
    etnLand,
    etnCodeLists,
  ],
});
