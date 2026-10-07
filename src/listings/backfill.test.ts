import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  backfillCutoff,
  backfillListings,
  parseBackfillArguments,
  resolveBackfillPlan,
} from "./backfill.js";
import type { ListingFetchHtml, ListingSourceAdapter, NormalizedListing } from "./types.js";

const now = new Date("2026-10-06T12:00:00.000Z");

function listing(id: string): NormalizedListing {
  return {
    source: "kw", sourceListingId: id, url: `https://kwslovenia.com/oglas/${id}-prodaja-hisa`,
    transactionType: "sale", propertyType: "house", title: `House ${id}`,
    description: null, locationText: "Ljubljana", address: null, price: 100_000,
    currency: "EUR", priceUnit: "total", areaM2: 80, landAreaM2: null, rooms: 3,
    latitude: null, longitude: null, locationAccuracy: "unknown", images: [],
  };
}

function database() {
  let inserts = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql.includes("INSERT INTO public.property_listings")) {
      inserts += 1;
      return { rows: [{ inserted: inserts === 1 }], rowCount: 1 };
    }
    if (sql.includes("SET active = false")) return { rows: [], rowCount: 5 };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool;
  return { pool, query, release };
}

function htmlAdapter(): ListingSourceAdapter {
  return {
    key: "kw", name: "Keller Williams Slovenia", homepage: "https://kwslovenia.com", priority: 4, minDelayMs: 30_000,
    searchUrl: () => "https://kwslovenia.com/oglasi/prodaja",
    parseSearchPage: (html) => JSON.parse(html),
    parseListing: (_html, url) => listing(new URL(url).pathname.match(/\/oglas\/(\d+)/)?.[1] ?? ""),
  };
}

function fetchPages(pages: Record<string, { listingUrls: string[]; nextPageUrl: string | null; publishedAt?: Record<string, string> }>): ListingFetchHtml {
  return vi.fn(async (request) => {
    const url = typeof request === "string" ? request : request.url;
    const page = pages[url];
    if (page) return JSON.stringify(page);
    return "detail";
  });
}

describe("listing backfill plan", () => {
  it("defaults to three months and the enabled sources", () => {
    const previous = process.env.LISTING_SOURCES;
    process.env.LISTING_SOURCES = "bolha";
    try {
      expect(resolveBackfillPlan({}, now)).toMatchObject({
        sources: ["re-max", "kw", "oglasnik"],
        transactionTypes: ["sale", "rent"],
        months: 3,
        lookbackDays: null,
        maxPages: 200,
        maxListings: 5_000,
        publishedAfter: new Date("2026-07-06T00:00:00.000Z"),
      });
    } finally {
      if (previous === undefined) delete process.env.LISTING_SOURCES;
      else process.env.LISTING_SOURCES = previous;
    }
    expect(backfillCutoff({ lookbackDays: 90 }, now).toISOString()).toBe("2026-07-08T00:00:00.000Z");
  });

  it("parses a lookback and refuses disabled sources", () => {
    expect(parseBackfillArguments(["--months=6", "--sources=re-max", "--transaction-types=sale"])).toEqual({
      help: false,
      options: { months: 6, sources: ["re-max"], transactionTypes: ["sale"] },
    });
    expect(parseBackfillArguments(["--help"])).toEqual({ help: true });
    expect(() => parseBackfillArguments(["--sources=bolha"])).toThrow(/bolha/);
    expect(() => parseBackfillArguments(["--months=0"])).toThrow(/months/);
    expect(() => parseBackfillArguments(["--months=3", "--lookback-days=10"])).toThrow(/not both/);
    expect(() => resolveBackfillPlan({ sources: ["nepremicnine-net"] })).toThrow(/disabled/);
  });
});

describe("listing backfill orchestration", () => {
  it("upserts ads inside the window, skips older detail pages, and does not retire unseen ads", async () => {
    const pages = {
      "https://kwslovenia.com/oglasi/prodaja": {
        listingUrls: [listing("1").url, listing("2").url],
        nextPageUrl: "https://kwslovenia.com/oglasi/prodaja?page=2",
        publishedAt: {
          [listing("1").url]: "2026-10-01T00:00:00.000Z",
          [listing("2").url]: "2026-09-01T00:00:00.000Z",
        },
      },
      "https://kwslovenia.com/oglasi/prodaja?page=2": {
        listingUrls: [listing("3").url],
        nextPageUrl: "https://kwslovenia.com/oglasi/prodaja?page=3",
        publishedAt: { [listing("3").url]: "2026-06-01T00:00:00.000Z" },
      },
      "https://kwslovenia.com/oglasi/prodaja?page=3": {
        listingUrls: [listing("4").url],
        nextPageUrl: null,
        publishedAt: { [listing("4").url]: "2026-05-01T00:00:00.000Z" },
      },
    };
    const db = database();
    const fetchHtml = fetchPages(pages);
    const progress: string[] = [];
    const result = await backfillListings(db.pool, {
      sources: ["kw"], transactionTypes: ["sale"], months: 3, now,
    }, {
      adapters: { kw: htmlAdapter() },
      fetchHtml,
      onProgress: (summary) => progress.push(summary.phase),
    });
    expect(result.stopped).toBe(false);
    expect(result.publishedAfter).toBe("2026-07-06T00:00:00.000Z");
    expect(result.summaries[0]).toMatchObject({
      source: "kw", transactionType: "sale", status: "success",
      inserted: 1, updated: 1, skipped: 1, outsideLookback: 1,
      reachedLookback: true, lookbackApplied: true, deactivated: 0, errors: 0,
    });
    const urls = vi.mocked(fetchHtml).mock.calls.map(([request]) => typeof request === "string" ? request : request.url);
    expect(urls).toEqual([
      "https://kwslovenia.com/oglasi/prodaja",
      listing("1").url,
      listing("2").url,
      "https://kwslovenia.com/oglasi/prodaja?page=2",
    ]);
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("SET active = false"))).toBe(false);
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("ON CONFLICT (id) DO UPDATE"))).toBe(true);
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("pg_advisory_unlock"))).toBe(true);
    expect(progress).toContain("page");
    expect(progress.at(-1)).toBe("source");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("walks an undated catalogue until it ends", async () => {
    const pages = {
      "https://kwslovenia.com/oglasi/prodaja": {
        listingUrls: [listing("1").url],
        nextPageUrl: "https://kwslovenia.com/oglasi/prodaja?page=2",
      },
      "https://kwslovenia.com/oglasi/prodaja?page=2": {
        listingUrls: [listing("2").url],
        nextPageUrl: null,
      },
    };
    const db = database();
    const fetchHtml = fetchPages(pages);
    const result = await backfillListings(db.pool, { sources: ["kw"], transactionTypes: ["sale"], now }, {
      adapters: { kw: htmlAdapter() }, fetchHtml,
    });
    expect(result.summaries[0]).toMatchObject({
      status: "success", pages: 2, inserted: 1, updated: 1, lookbackApplied: false, catalogueExhausted: true, reachedLookback: false,
    });
    expect(vi.mocked(fetchHtml).mock.calls.map(([request]) => typeof request === "string" ? request : request.url)).toEqual([
      "https://kwslovenia.com/oglasi/prodaja",
      listing("1").url,
      "https://kwslovenia.com/oglasi/prodaja?page=2",
      listing("2").url,
    ]);
  });

  it("continues after a source failure and stops before any request when already aborted", async () => {
    const db = database();
    const oglasnikListing: NormalizedListing = { ...listing("9"), source: "oglasnik", url: "https://oglasnik.si/oglasi/hisa/" };
    const failing: ListingSourceAdapter = {
      key: "re-max", name: "RE/MAX Slovenia", homepage: "https://www.re-max.si", priority: 2,
      searchUrl: () => "https://www.re-max.si/search",
      parseSearchPage: () => { throw new Error("unused"); },
      parseListing: () => null,
      readCatalogue: async () => { throw new Error("RE/MAX Slovenia returned HTTP 500"); },
    };
    const oglasnik: ListingSourceAdapter = {
      key: "oglasnik", name: "Oglasnik.si", homepage: "https://oglasnik.si", priority: 5,
      searchUrl: () => "https://oglasnik.si/kategorija-oglasa/nepremicnine/feed/",
      parseSearchPage: () => { throw new Error("unused"); },
      parseListing: () => null,
      readCatalogue: async (_type, limits) => {
        const batch = {
          listings: [oglasnikListing], pages: 1, skipped: 0, fetched: 1, outsideLookback: 0,
          reachedLookback: false, lookbackApplied: true, exhausted: true, capped: false,
        };
        await limits.onBatch?.(batch);
        return { ...batch, complete: false };
      },
    };
    const fetchHtml = vi.fn<ListingFetchHtml>();
    const result = await backfillListings(db.pool, { sources: ["re-max", "oglasnik"], transactionTypes: ["sale"], now }, {
      adapters: { "re-max": failing, oglasnik }, fetchHtml,
    });
    expect(result.summaries.map((summary) => [summary.source, summary.status, summary.errors, summary.inserted])).toEqual([
      ["re-max", "failed", 1, 0],
      ["oglasnik", "success", 0, 1],
    ]);
    expect(result.summaries[0]?.error).toMatch(/HTTP 500/);
    const controller = new AbortController();
    controller.abort();
    const stopped = await backfillListings(db.pool, { sources: ["kw"], transactionTypes: ["sale"], now }, {
      adapters: { kw: htmlAdapter() }, fetchHtml, signal: controller.signal,
    });
    expect(stopped.stopped).toBe(true);
    expect(stopped.summaries).toEqual([]);
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it("rejects Bolha before opening a connection and skips when the import lock is held", async () => {
    const db = database();
    await expect(backfillListings(db.pool, { sources: ["bolha"] })).rejects.toThrow(/bolha/);
    expect(db.pool.connect).not.toHaveBeenCalled();
    db.query.mockResolvedValue({ rows: [{ locked: false }], rowCount: 1 });
    const fetchHtml = vi.fn<ListingFetchHtml>();
    await expect(backfillListings(db.pool, { sources: ["kw"], transactionTypes: ["sale"] }, {
      adapters: { kw: htmlAdapter() }, fetchHtml,
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(fetchHtml).not.toHaveBeenCalled();
    expect(db.release).toHaveBeenCalledOnce();
  });
});
