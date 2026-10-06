import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerGlobalAuth } from "../src/auth.js";
import { encodeCursor } from "../src/gurs/query.js";
import { listingRoutes } from "../src/routes/listings.js";
import { registerSwagger } from "../src/swagger.js";

const headers = { "x-api-key": "test-password" };

function createApp(query = vi.fn().mockResolvedValue({ rows: [] })) {
  const app = Fastify({ logger: false });
  registerSwagger(app);
  registerGlobalAuth(app, headers["x-api-key"], ["/docs"]);
  app.register(listingRoutes({ query } as unknown as Pool));
  return { app, query };
}

describe("advertisement read API", () => {
  it("returns prioritized sources with adapter availability without querying the property tables", async () => {
    const { app, query } = createApp();
    const response = await app.inject({ url: "/listings/sources", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "nepremicnine-net", priority: 1, enabled: false }),
      expect.objectContaining({ key: "bolha", priority: 2, enabled: true }),
    ]));
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([["sales", "sale"], ["rentals", "rent"]])(
    "keeps %s separate and returns stable pagination with coordinates and asking-price units",
    async (layer, transaction) => {
      const query = vi.fn().mockResolvedValue({ rows: [
        {
          id: `bolha:${transaction}:1`, transaction_type: transaction,
          price: "250000.5", currency: "EUR", price_unit: "total",
          area_m2: "142.8", rooms: "3.5", latitude: null, longitude: null,
          location_accuracy: "unknown", images: [], active: true,
        },
        { id: `bolha:${transaction}:2` },
      ] });
      const { app } = createApp(query);
      const response = await app.inject({ url: `/listings/${layer}?limit=1`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        items: [{ id: `bolha:${transaction}:1`, transactionType: transaction,
          price: 250000.5, currency: "EUR", priceUnit: "total", areaM2: 142.8,
          rooms: 3.5, latitude: null, longitude: null, locationAccuracy: "unknown" }],
        page: { hasMore: true, nextCursor: encodeCursor(`bolha:${transaction}:1`) },
      });
      expect(query.mock.calls[0]?.[0]).toContain("FROM public.property_listings");
      expect(query.mock.calls[0]?.[0]).not.toContain("map.sales");
      expect(query.mock.calls[0]?.[0]).toContain("ORDER BY feature.id ASC");
      expect(query.mock.calls[0]?.[1]).toEqual([transaction, true, 2]);
      await app.close();
    },
  );

  it("parameterizes all list filters and allows an explicit inactive/all selection", async () => {
    const { app, query } = createApp();
    const response = await app.inject({
      url: "/listings/sales?active=all&source=bolha&propertyType=house&priceUnit=total&priceMin=100000&priceMax=300000&areaMin=80&areaMax=180&bbox=14,45,16,47",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], page: { hasMore: false, nextCursor: null } });
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual(["sale", "bolha", "house", "total", 100000, 300000, 80, 180, 14, 45, 16, 47, 51]);
    expect(sql).toContain("feature.geom && ST_MakeEnvelope($9, $10, $11, $12, 4326)");
    expect(sql).not.toContain("feature.active =");
    await app.inject({ url: "/listings/rentals?active=false", headers });
    expect(query.mock.calls[1]?.[1]).toEqual(["rent", false, 51]);
    await app.close();
  });

  it("uses cursor and detail IDs as parameters rather than SQL", async () => {
    const attack = "bolha:sale:1' OR 1=1 --";
    const { app, query } = createApp();
    const cursor = encodeCursor(attack);
    const response = await app.inject({ url: `/listings/sales?cursor=${cursor}`, headers });
    expect(response.statusCode).toBe(200);
    expect(query.mock.calls[0]?.[0]).toContain("feature.id > $3");
    expect(query.mock.calls[0]?.[0]).not.toContain(attack);
    expect(query.mock.calls[0]?.[1]).toEqual(["sale", true, attack, 51]);
    const detail = await app.inject({ url: `/listings/rentals/${encodeURIComponent(attack)}`, headers });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toEqual({ message: "Listing not found" });
    expect(query.mock.calls[1]?.[0]).toContain("feature.id = $1 AND feature.transaction_type = $2");
    expect(query.mock.calls[1]?.[0]).not.toContain(attack);
    expect(query.mock.calls[1]?.[1]).toEqual([attack, "rent"]);
    await app.close();
  });

  it("returns a saved inactive rental with its source, accurate coordinates, and timestamps", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: "bolha:rent:123", source: "bolha", source_listing_id: "123",
      url: "https://www.bolha.com/oddaja-his/ad-123", transaction_type: "rent",
      price: "1200", price_unit: "month", latitude: 46.06, longitude: 14.51,
      location_accuracy: "approximate", active: false,
      last_seen_at: "2026-10-05T08:00:00Z",
    }] });
    const { app } = createApp(query);
    const response = await app.inject({ url: "/listings/rentals/bolha:rent:123", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: "bolha", sourceListingId: "123", transactionType: "rent",
      price: 1200, priceUnit: "month", latitude: 46.06, longitude: 14.51,
      locationAccuracy: "approximate", active: false, lastSeenAt: "2026-10-05T08:00:00Z",
    });
    await app.close();
  });

  it.each([
    "sql=drop", "source=unknown", "source=bolha&source=si21", "propertyType=castle",
    "priceMin=10", "priceMax=10", "priceUnit=month&priceMin=-1",
    "priceUnit=month&priceMin=Infinity", "priceUnit=month&priceMin=",
    "priceUnit=total&priceMin=200&priceMax=100", "priceUnit=annual",
    "areaMin=100&areaMax=10", "areaMax=1%27%20OR%201=1", "active=1",
    "bbox=14,45,16", "bbox=14,,16,47", "bbox=14,45,181,47",
    "limit=0", "limit=201", "limit=0x10", "cursor=invalid",
  ])("rejects invalid or unsupported filters before SQL: %s", async (queryString) => {
    const { app, query } = createApp();
    const response = await app.inject({ url: `/listings/sales?${queryString}`, headers });
    expect(response.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("advertisement map API", () => {
  it.each([["sales", "sale"], ["rentals", "rent"]])("renders a separate %s point layer at zoom 12", async (layer, transaction) => {
    const tile = Buffer.from([0x1a, 0x00]);
    const query = vi.fn().mockResolvedValue({ rows: [{ tile }] });
    const { app } = createApp(query);
    const response = await app.inject({
      url: `/listings/map/tiles/${layer}/12/2200/1437.mvt?source=bolha&propertyType=house&priceUnit=month&priceMin=500`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/vnd.mapbox-vector-tile");
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(response.rawPayload).toEqual(tile);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`'listing_${layer}'`);
    expect(sql).toContain("feature.transaction_type = $4");
    expect(sql).toContain("feature.active = true");
    expect(sql).toContain("feature.geom IS NOT NULL");
    expect(sql).toContain("feature.price::double precision AS asking_price");
    expect(sql).toContain("feature.source, feature.url");
    expect(sql).toContain("feature.price_unit, feature.property_type, feature.location_accuracy");
    expect(sql).not.toContain("GROUP BY");
    expect(values).toEqual([12, 2200, 1437, transaction, "bolha", "house", "month", 500]);
    await app.close();
  });

  it("clusters active rentals at zoom 11 and handles an empty tile", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ tile: null }] });
    const { app } = createApp(query);
    const response = await app.inject({ url: "/listings/map/tiles/rentals/11/1100/718.mvt", headers });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toHaveLength(0);
    expect(query.mock.calls[0]?.[0]).toContain("GROUP BY ST_SnapToGrid");
    expect(query.mock.calls[0]?.[0]).toContain("count(*)::int AS cluster_count");
    expect(query.mock.calls[0]?.[0]).toContain("'listing_rentals'");
    expect(query.mock.calls[0]?.[1]).toEqual([11, 1100, 718, "rent"]);
    await app.close();
  });

  it.each([
    "properties/12/2200/1437.mvt", "sales/23/1/1.mvt", "sales/0/1/0.mvt",
    "sales/12/-1/1437.mvt", "sales/12/2200/4096.mvt", "sales/12/1.5/1.mvt",
    "sales/12/2200/1437.mvt?active=all", "sales/12/2200/1437.mvt?limit=1",
    "sales/12/2200/1437.mvt?priceMin=10", "sales/12/2200/1437.mvt?sql=drop",
  ])("validates listing tile bounds and filters before PostGIS: %s", async (path) => {
    const { app, query } = createApp();
    const response = await app.inject({ url: `/listings/map/tiles/${path}`, headers });
    expect(response.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("advertisement API authentication and documentation", () => {
  it.each([
    "/listings/sources", "/listings/sales", "/listings/rentals",
    "/listings/sales/bolha:sale:1", "/listings/rentals/bolha:rent:1",
    "/listings/map/tiles/sales/12/2200/1437.mvt",
  ])("requires the existing API key for %s", async (url) => {
    const { app, query } = createApp();
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });

  it("documents the independent listing routes, map layers, and price-unit requirement", async () => {
    const { app } = createApp();
    await app.ready();
    const paths = app.swagger().paths as Record<string, { get: Record<string, unknown> }>;
    for (const path of ["/listings/sources", "/listings/sales", "/listings/rentals",
      "/listings/sales/{id}", "/listings/rentals/{id}",
      "/listings/map/tiles/{layer}/{z}/{x}/{y}.mvt"]) {
      expect(paths[path]?.get.summary).toEqual(expect.any(String));
      expect(paths[path]?.get.description).toEqual(expect.any(String));
      expect(paths[path]?.get.security).toEqual([{ apiKey: [] }]);
    }
    expect(paths["/listings/sales"]?.get.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "priceUnit", description: expect.stringContaining("Required") }),
      expect.objectContaining({ name: "active", description: expect.stringContaining("Defaults to true") }),
      expect.objectContaining({ name: "bbox" }),
    ]));
    expect(paths["/listings/map/tiles/{layer}/{z}/{x}/{y}.mvt"]?.get.description)
      .toContain("listing_sales");
    await app.close();
  });
});
