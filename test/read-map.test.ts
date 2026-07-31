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
