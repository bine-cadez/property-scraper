import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_LIVE_SAMPLE_SIZE,
  replaceLiveGursSample,
  validateLiveSampleSize,
} from "./ingest.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("validateLiveSampleSize", () => {
  it("accepts the endpoint maximum", () => {
    expect(validateLiveSampleSize(MAX_LIVE_SAMPLE_SIZE)).toBe(10_000);
    expect(validateLiveSampleSize("10000")).toBe(10_000);
  });

  it.each([0, 10_001, 1.5, "", "nope", undefined])(
    "rejects invalid sample size %s",
    (value) => {
      expect(() => validateLiveSampleSize(value)).toThrow(
        "sampleSize must be an integer between 1 and 10000",
      );
    },
  );
});

describe("replaceLiveGursSample", () => {
  it("retries transient fetch failures without restarting the ingest", async () => {
    vi.useFakeTimers();
    const databaseQuery = vi.fn().mockImplementation(async (statement: string) => {
      if (statement.includes("FROM gurs_etn_transactions")) {
        return {
          rows: [{ id_posla: "99", contract_date: "2025-12-01" }],
        };
      }
      if (statement.includes("FROM gurs_etn_building_parts")) {
        return {
          rows: [
            {
              record_key: "part:1",
              id_posla: "99",
              ko_id: 10,
              building_number: 20,
              part_number: 3,
            },
          ],
        };
      }
      if (statement.includes("FROM gurs_etn_land")) return { rows: [] };
      if (statement.includes("count(*)::int AS count")) {
        return { rows: [{ count: 0 }] };
      }
      return { rows: [] };
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            features: [],
            numberMatched: 0,
            numberReturned: 0,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const clientQuery = vi.fn().mockResolvedValue({});
    const database = {
      query: databaseQuery,
      connect: vi.fn().mockResolvedValue({
        query: clientQuery,
        release: vi.fn(),
      }),
    } as unknown as Pool;
    const onProgress = vi.fn();

    const ingest = replaceLiveGursSample(database, 1, {
      transactionYear: 2025,
      onProgress,
    });
    await vi.runAllTimersAsync();
    await ingest;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "fetch",
        message: "Fetch failed; retrying request 2/7",
      }),
    );
  });

  it("reuses persisted fetches after a failed replacement", async () => {
    const responses = new Map<string, unknown>();
    const databaseQuery = vi.fn().mockImplementation(
      async (statement: string, values?: unknown[]) => {
        if (statement.includes("FROM gurs_etn_transactions")) {
          return {
            rows: [{ id_posla: "99", contract_date: "2025-12-01" }],
          };
        }
        if (statement.includes("FROM gurs_etn_building_parts")) {
          return {
            rows: [
              {
                record_key: "part:1",
                id_posla: "99",
                ko_id: 10,
                building_number: 20,
                part_number: 3,
              },
            ],
          };
        }
        if (statement.includes("FROM gurs_etn_land")) return { rows: [] };
        if (statement.includes("SELECT response")) {
          const key = `${String(values?.[0])}:${String(values?.[1])}`;
          return responses.has(key)
            ? { rows: [{ response: responses.get(key) }] }
            : { rows: [] };
        }
        if (statement.includes("INSERT INTO public.gurs_ingest_fetch_cache")) {
          const key = `${String(values?.[0])}:${String(values?.[1])}`;
          responses.set(key, JSON.parse(String(values?.[3])));
          return { rows: [] };
        }
        if (statement.includes("count(*)::int AS count")) {
          return { rows: [{ count: responses.size }] };
        }
        return { rows: [] };
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          features: [],
          numberMatched: 0,
          numberReturned: 0,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    let failReplacement = true;
    const clientQuery = vi.fn().mockImplementation(async (statement: string) => {
      if (failReplacement && statement.startsWith("TRUNCATE TABLE")) {
        throw new Error("database failure");
      }
      return {};
    });
    const database = {
      query: databaseQuery,
      connect: vi.fn().mockResolvedValue({
        query: clientQuery,
        release: vi.fn(),
      }),
    } as unknown as Pool;

    await expect(
      replaceLiveGursSample(database, 1, { transactionYear: 2025 }),
    ).rejects.toThrow("database failure");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(responses.size).toBe(1);

    failReplacement = false;
    const onProgress = vi.fn();
    await replaceLiveGursSample(database, 1, {
      transactionYear: 2025,
      onProgress,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "fetch",
        details: expect.objectContaining({ cacheHit: true }),
      }),
    );
  });

  it("anchors to ETN transactions and expands a coherent CQL graph", async () => {
    const anchorQuery = vi.fn().mockImplementation(async (statement: string) => {
      if (statement.includes("FROM gurs_etn_transactions")) {
        return {
          rows: [{ id_posla: "99", contract_date: "2025-12-01" }],
        };
      }
      if (statement.includes("FROM gurs_etn_building_parts")) {
        return {
          rows: [
            {
              record_key: "part:1",
              id_posla: "99",
              ko_id: 10,
              building_number: 20,
              part_number: 3,
            },
          ],
        };
      }
      if (statement.includes("FROM gurs_etn_land")) {
        return {
          rows: [
            {
              record_key: "land:1",
              id_posla: "99",
              ko_id: 10,
              parcel_number: "42/1",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const feature = (
      properties: Record<string, unknown>,
      geometry: unknown = null,
    ) => ({ properties, geometry });
    const fetchMock = vi.fn().mockImplementation(async (input: URL) => {
      const url = new URL(String(input));
      const collection = url.pathname.split("/").at(-2);
      const featuresByCollection: Record<string, unknown[]> = {
        DELI_STAVB: [
          feature({
            EID_DEL_STAVBE: "part-eid",
            EID_STAVBA: "building-eid",
            KO_ID: 10,
            ST_STAVBE: 20,
            ST_DELA_STAVBE: 3,
          }),
        ],
        PARCELE: [
          feature(
            {
              EID_PARCELA: "parcel-eid",
              KO_ID: 10,
              ST_PARCELE: "42/1",
            },
            { type: "Polygon", coordinates: [] },
          ),
        ],
        STAVBE_PARCELE: [
          feature({
            EID_STAVBA_PARCELA: "relation-eid",
            EID_STAVBA: "building-eid",
            EID_PARCELA: "parcel-eid",
          }),
        ],
        STAVBE: [
          feature({
            EID_STAVBA: "building-eid",
            KO_ID: 10,
            ST_STAVBE: 20,
            E_CEN: 460000,
            N_CEN: 100000,
          }),
        ],
        NASLOVI_HS: [
          feature({
            EID_HISNA_STEVILKA: "address-eid",
            EID_STAVBA: "building-eid",
            HS_STEVILKA: 1,
          }),
        ],
        KATASTRSKE_OBCINE: [
          feature({
            EID_KATASTRSKA_OBCINA: "municipality-eid",
            KO_ID: 10,
            NAZIV: "Test",
          }),
        ],
        PARCELA: [feature({ EID_PARCELA: "parcel-eid" })],
        PARC_ENOTA: [
          feature({
            ID_PARC_ENOTA: "parcel-unit",
            EID_PARCELA: "parcel-eid",
            ID_MODEL: "KME",
            POSPLOSENA_VREDNOST: 100,
          }),
        ],
        STAVBA: [feature({ EID_STAVBA: "building-eid" })],
        DEL_STAVBE: [feature({ EID_DEL_STAVBE: "part-eid" })],
        DEL_STAVBE_ENOTA: [
          feature({
            EID_DEL_STAVBE: "part-eid",
            ID_MODEL: "STA",
            POSPLOSENA_VREDNOST: 200,
          }),
        ],
      };
      const features = featuresByCollection[collection ?? ""] ?? [];
      return new Response(
        JSON.stringify({
          features,
          numberMatched: features.length,
          numberReturned: features.length,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const clientQuery = vi.fn().mockResolvedValue({});
    const release = vi.fn();
    const database = {
      query: anchorQuery,
      connect: vi.fn().mockResolvedValue({
        query: clientQuery,
        release,
      }),
    } as unknown as Pool;

    const result = await replaceLiveGursSample(database, 1, {
      transactionYear: 2025,
    });

    expect(anchorQuery).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY contract_date DESC"),
      [2025, 1],
    );
    expect(
      fetchMock.mock.calls.every(([input]) =>
        new URL(String(input)).searchParams.has("filter"),
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.every(
        ([input]) =>
          new URL(String(input)).searchParams.get("filter-lang") ===
          "cql-text",
      ),
    ).toBe(true);
    expect(result.coverage).toMatchObject({
      anchorTransactions: 1,
      buildingPartItems: 1,
      resolvedBuildingPartItems: 1,
      landItems: 1,
      resolvedLandItems: 1,
    });
    const sql = clientQuery.mock.calls.map(([statement]) => String(statement));
    expect(sql).toContainEqual(
      expect.stringContaining(
        "CREATE TEMP TABLE gurs_kn_buildings",
      ),
    );
    expect(sql).toContainEqual(
      expect.stringContaining(
        "INSERT INTO public.gurs_kn_buildings SELECT * FROM pg_temp.gurs_kn_buildings",
      ),
    );
    expect(sql).toContainEqual(
      expect.stringContaining(
        'item.parcel_number COLLATE "C" = parcel.parcel_number COLLATE "C"',
      ),
    );
    expect(sql.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("fetches in batches and atomically clears only live GURS tables", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: URL) => {
      const url = new URL(String(input));
      const isParcels = url.pathname.includes("/PARCELE/");
      const isParcelEnrichment = url.pathname.includes("/PARCELA/");
      const startIndex = Number(url.searchParams.get("startIndex"));
      const parcelCount = isParcels
        ? startIndex === 0
          ? 1_000
          : startIndex === 1_000
            ? 1
            : 0
        : 0;
      const parcelEnrichmentCount =
        isParcelEnrichment && startIndex === 0 ? 201 : 0;
      const features = isParcels
        ? Array.from({ length: parcelCount }, (_, index) => ({
            properties: {
              EID_PARCELA: String(startIndex + index),
              KO_ID: 1,
              ST_PARCELE: String(startIndex + index),
            },
          }))
        : Array.from({ length: parcelEnrichmentCount }, (_, index) => ({
            properties: {
              EID_PARCELA: String(index),
              BONITETA: 10,
            },
          }));

      return new Response(
        JSON.stringify({
          features,
          numberMatched: isParcels
            ? 1_001
            : isParcelEnrichment
              ? 201
              : 0,
          numberReturned: features.length,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const query = vi.fn().mockResolvedValue({});
    const release = vi.fn();
    const database = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;
    const onProgress = vi.fn();

    const result = await replaceLiveGursSample(database, 10_000, {
      onProgress,
    });

    const collectionUrls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/collections/"));
    expect(collectionUrls).toHaveLength(12);
    expect(
      collectionUrls.every(
        (url) =>
          new URL(url).searchParams.get("limit") === "1000",
      ),
    ).toBe(true);
    expect(
      collectionUrls.some(
        (url) =>
          new URL(url).pathname.includes("/PARCELE/") &&
          new URL(url).searchParams.get("startIndex") === "1000",
      ),
    ).toBe(true);

    const sql = query.mock.calls.map(([statement]) => String(statement));
    expect(sql[0]).toBe("BEGIN");
    expect(sql).toContain(
      "SELECT pg_advisory_xact_lock(hashtext('gurs-live-replacement'))",
    );

    const truncate = sql.find((statement) =>
      statement.startsWith("TRUNCATE TABLE"),
    );
    expect(truncate).toContain("gurs_kn_parcels");
    expect(truncate).toContain("gurs_ev_parcel_units");
    expect(truncate).not.toContain("gurs_etn_");
    const parcelEnrichmentQueries = sql.filter((statement) =>
      statement.startsWith('UPDATE "gurs_kn_parcels" AS target'),
    );
    expect(parcelEnrichmentQueries).toHaveLength(2);
    expect(parcelEnrichmentQueries[0]).toContain("jsonb_to_recordset");
    expect(sql.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
    expect(result.sampleSize).toBe(10_000);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "replace",
        source: "live GURS tables",
      }),
    );
  });

  it("skips and reports GURS valuation error rows", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: URL) => {
      const url = String(input);
      const isFailingCollection = url.includes("/DEL_STAVBE_ENOTA/");
      return new Response(
        JSON.stringify({
          features: isFailingCollection
            ? [
                {
                  id: "DEL_STAVBE_ENOTA.100300000207257010",
                  geometry: null,
                  properties: {
                    EID_DEL_STAVBE: "100300000207257010",
                    ID_MODEL: "NAPAKA",
                    RAVEN: null,
                    VPLIV: null,
                    POSPLOSENA_VREDNOST: null,
                  },
                },
              ]
            : [],
          numberMatched: isFailingCollection ? 1 : 0,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const query = vi.fn().mockResolvedValue({});
    const release = vi.fn();
    const database = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;

    const result = await replaceLiveGursSample(database, 10);
    const summary = result.summaries.find(
      ({ source }) => source === "EV DEL_STAVBE_ENOTA sample",
    );

    expect(summary).toEqual({
      source: "EV DEL_STAVBE_ENOTA sample",
      rows: 0,
      skippedRows: 1,
      skipReason: "missing required valuation fields",
    });
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining(
        'INSERT INTO "gurs_ev_building_part_units"',
      ),
      expect.anything(),
    );
  });

  it("rolls back the replacement when importing fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        return new Response(JSON.stringify({ features: [] }), {
          status: 200,
        });
      }),
    );

    const query = vi.fn().mockImplementation(async (statement: string) => {
      if (statement.startsWith("TRUNCATE TABLE")) {
        throw new Error("database failure");
      }
      return {};
    });
    const release = vi.fn();
    const database = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;

    await expect(replaceLiveGursSample(database, 10)).rejects.toThrow(
      "database failure",
    );

    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
