import { describe, expect, it, vi } from "vitest";

import { refreshMapTables } from "./map-refresh.js";

describe("map refresh", () => {
  it("stores summed modelled values for buildings and parcels", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

    await refreshMapTables({ query });

    expect(query).toHaveBeenCalledTimes(5);
    const propertySql = String(query.mock.calls[1]?.[0]);
    expect(propertySql).toContain(
      "building_type_code, gross_floor_area, modelled_value, pin, footprint",
    );
    expect(propertySql).toContain("sum(unit.modelled_value)");
    expect(propertySql).toContain("part.eid_stavba = building.eid_stavba");

    const parcelSql = String(query.mock.calls[3]?.[0]);
    expect(parcelSql).toContain(
      "eid_parcela, ko_id, parcel_number, area, modelled_value, geom",
    );
    expect(parcelSql).toContain("sum(unit.modelled_value)");
    expect(parcelSql).toContain("unit.eid_parcela = parcel.eid_parcela");
  });
});
