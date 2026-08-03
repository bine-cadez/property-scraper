import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  databaseUrl: "postgres://unused",
  authKey: "test-password",
};

const headers = { "x-api-key": config.authKey };

describe("read API", () => {
  it("returns stable cursor pagination and serializes numeric values", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      eid_parcela: String(index).padStart(3, "0"),
      ko_id: 1,
      parcel_number: String(index),
      area: "12.5",
    }));
    const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
    const end = vi.fn();
    const app = buildApp(config, { query, end } as unknown as Pool);

    const response = await app.inject({
      method: "GET",
      url: "/gurs/parcels?limit=50&koId=1",
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(50);
    expect(response.json().items[0]).toMatchObject({
      eidParcela: "000",
      area: 12.5,
    });
    expect(response.json().page).toMatchObject({ hasMore: true });
    expect(response.json().page.nextCursor).toEqual(expect.any(String));
    expect(query.mock.calls[0]?.[0]).toContain("ORDER BY parcel.eid_parcela");
    expect(query.mock.calls[0]?.[1]).toEqual(["1", 51]);
    await app.close();
  });

  it("rejects unknown filters without executing SQL", async () => {
    const query = vi.fn();
    const end = vi.fn();
    const app = buildApp(config, { query, end } as unknown as Pool);

    const response = await app.inject({
      method: "GET",
      url: "/gurs/buildings?sql=drop",
      headers,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("Unknown filter");
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });

  it("embeds all related arrays in building details", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            eid_stavba: "building-1",
            gross_floor_area: "3073.2",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            eid_hisna_stevilka: "address-1",
            eid_stavba: "building-1",
            centroid_e: "14.5",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            eid_del_stavbe: "part-1",
            eid_stavba: "building-1",
            area: "72.4",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ eid_parcela: "parcel-1", area: "500.5" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ eid_del_stavbe: "part-1", modelled_value: "250000" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id_posla: "sale-1", total_price: "275000" }],
        rowCount: 1,
      });
    const end = vi.fn();
    const app = buildApp(config, { query, end } as unknown as Pool);

    const response = await app.inject({
      method: "GET",
      url: "/gurs/buildings/building-1",
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      eidStavba: "building-1",
      grossFloorArea: 3073.2,
      addresses: [
        {
          eidHisnaStevilka: "address-1",
          eidStavba: "building-1",
          centroidE: 14.5,
        },
      ],
      parts: [
        {
          eidDelStavbe: "part-1",
          eidStavba: "building-1",
          area: 72.4,
        },
      ],
      parcels: [{ eidParcela: "parcel-1", area: 500.5 }],
      valuationUnits: [
        { eidDelStavbe: "part-1", modelledValue: 250000 },
      ],
      sales: [{ idPosla: "sale-1", totalPrice: 275000 }],
    });
    expect(response.json()).not.toHaveProperty("relationships");
    expect(query).toHaveBeenCalledTimes(6);
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual(["building-1"]);
    }
    expect(query.mock.calls[5]?.[0]).toContain("WHERE EXISTS");
    await app.close();
  });

  it("embeds all related arrays in parcel details", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ eid_parcela: "parcel-1", area: "500.5" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ eid_stavba: "building-1", gross_floor_area: "3073.2" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ parcel_unit_id: "unit-1", modelled_value: "100000" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ eid_hisna_stevilka: "address-1", centroid_e: "14.5" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ eid_del_stavbe: "part-1", area: "72.4" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id_posla: "sale-1", total_price: "275000" }],
        rowCount: 1,
      });
    const end = vi.fn();
    const app = buildApp(config, { query, end } as unknown as Pool);

    const response = await app.inject({
      method: "GET",
      url: "/gurs/parcels/parcel-1",
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      eidParcela: "parcel-1",
      area: 500.5,
      buildings: [{ eidStavba: "building-1", grossFloorArea: 3073.2 }],
      valuationUnits: [{ parcelUnitId: "unit-1", modelledValue: 100000 }],
      addresses: [{ eidHisnaStevilka: "address-1", centroidE: 14.5 }],
      parts: [{ eidDelStavbe: "part-1", area: 72.4 }],
      sales: [{ idPosla: "sale-1", totalPrice: 275000 }],
    });
    expect(response.json()).not.toHaveProperty("relationships");
    expect(query).toHaveBeenCalledTimes(6);
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual(["parcel-1"]);
    }
    expect(query.mock.calls[5]?.[0]).toContain("WHERE EXISTS");
    await app.close();
  });

  it("embeds related records in building-part details", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            eid_del_stavbe: "part-1",
            eid_stavba: "building-1",
            area: "72.4",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ eid_stavba: "building-1", gross_floor_area: "3073.2" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ eid_hisna_stevilka: "address-1", centroid_e: "14.5" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ eid_parcela: "parcel-1", area: "500.5" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ eid_del_stavbe: "part-1", modelled_value: "250000" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id_posla: "sale-1", total_price: "275000" }],
        rowCount: 1,
      });
    const end = vi.fn();
    const app = buildApp(config, { query, end } as unknown as Pool);

    const response = await app.inject({
      method: "GET",
      url: "/gurs/building-parts/part-1",
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      eidDelStavbe: "part-1",
      eidStavba: "building-1",
      area: 72.4,
      building: { eidStavba: "building-1", grossFloorArea: 3073.2 },
      addresses: [{ eidHisnaStevilka: "address-1", centroidE: 14.5 }],
      parcels: [{ eidParcela: "parcel-1", area: 500.5 }],
      valuationUnits: [
        { eidDelStavbe: "part-1", modelledValue: 250000 },
      ],
      sales: [{ idPosla: "sale-1", totalPrice: 275000 }],
    });
    expect(response.json()).not.toHaveProperty("relationships");
    expect(query).toHaveBeenCalledTimes(6);
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      ["part-1"],
      ["building-1"],
      ["building-1"],
      ["building-1"],
      ["part-1"],
      ["part-1"],
    ]);
    expect(query.mock.calls[5]?.[0]).toContain("WHERE EXISTS");
    await app.close();
  });
});

describe("map API", () => {
  it("returns an empty parcel tile below zoom 15 without querying PostGIS", async () => {
    const query = vi.fn();
    const end = vi.fn();
    const app = buildApp(config, { query, end } as unknown as Pool);

    const response = await app.inject({
      method: "GET",
      url: "/map/tiles/parcels/14/8800/5750.mvt",
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain(
      "application/vnd.mapbox-vector-tile",
    );
    expect(response.rawPayload).toHaveLength(0);
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });

  it("includes and filters the modelled value in parcel tiles", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ tile: Buffer.from([0x1a, 0x00]) }],
      rowCount: 1,
    });
    const end = vi.fn();
    const app = buildApp(config, { query, end } as unknown as Pool);

    const response = await app.inject({
      method: "GET",
      url: "/map/tiles/parcels/15/17600/11500.mvt?valuationValueMin=100000",
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(query.mock.calls[0]?.[0]).toContain("feature.modelled_value");
    expect(query.mock.calls[0]?.[1]).toEqual([
      15,
      17600,
      11500,
      100000,
    ]);
    await app.close();
  });

  it("includes and filters the modelled value in building tiles", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ tile: Buffer.from([0x1a, 0x00]) }],
      rowCount: 1,
    });
    const end = vi.fn();
    const app = buildApp(config, { query, end } as unknown as Pool);

    const response = await app.inject({
      method: "GET",
      url: "/map/tiles/properties/12/2200/1437.mvt?valuationValueMax=300000",
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(query.mock.calls[0]?.[0]).toContain("feature.modelled_value");
    expect(query.mock.calls[0]?.[1]).toEqual([
      12,
      2200,
      1437,
      300000,
    ]);
    await app.close();
  });

  it("renders individual sale items at zoom 12 and applies safe filters", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ tile: Buffer.from([0x1a, 0x00]) }],
      rowCount: 1,
    });
    const end = vi.fn();
    const app = buildApp(config, { query, end } as unknown as Pool);

    const response = await app.inject({
      method: "GET",
      url: "/map/tiles/sales/12/2200/1437.mvt?itemKind=land&priceMin=1000",
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.from([0x1a, 0x00]));
    expect(query.mock.calls[0]?.[0]).toContain("'pin'::text AS feature_type");
    expect(query.mock.calls[0]?.[1]).toEqual([
      12,
      2200,
      1437,
      "land",
      1000,
    ]);
    await app.close();
  });
});
