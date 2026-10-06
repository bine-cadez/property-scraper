import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { assertListingSourceUrl, createListingFetcher, ingestListings, validateListingIngestOptions } from "./ingest.js";
import type { ListingSourceAdapter, NormalizedListing } from "./types.js";
import axios from "axios";

const listing: NormalizedListing = {
  source: "bolha", sourceListingId: "123", url: "https://www.bolha.com/house-123",
  transactionType: "sale", propertyType: "house", title: "House in Ljubljana",
  description: null, locationText: "Ljubljana", address: null, price: 300_000,
  currency: "EUR", priceUnit: "total", areaM2: 120, landAreaM2: 500, rooms: null,
  latitude: 46.05, longitude: 14.5, locationAccuracy: "approximate", images: [],
};
function adapter(): ListingSourceAdapter {
  return {
    key: "bolha", name: "Bolha", homepage: "https://www.bolha.com", priority: 2,
    searchUrl: () => "https://www.bolha.com/search",
    parseSearchPage: (html) => JSON.parse(html),
    parseListing: () => listing,
  };
}
function database() {
  const query = vi.fn().mockImplementation(async (sql: string) => ({
    rows: sql.includes("pg_try_advisory_lock") ? [{ locked: true }] : [], rowCount: sql.includes("UPDATE public.property_listings SET active = false") ? 2 : 1,
  }));
  const release = vi.fn();
  const client = { query, release };
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool, query, release };
}
function fetchPages(nextPageUrl: string | null = null) {
  return vi.fn(async (url: string) => url.includes("search") ? JSON.stringify({ listingUrls: [listing.url], nextPageUrl }) : "detail");
}

describe("listing imports", () => {
  it("upserts stable source identities and retires unseen ads only for a complete catalogue", async () => {
    const db = database();
    const result = await ingestListings(db.pool, { sources: ["bolha"], transactionTypes: ["sale"] }, { adapters: { bolha: adapter() }, fetchHtml: fetchPages() });
    expect(result.summaries).toEqual([expect.objectContaining({ status: "success", saved: 1, located: 1, complete: true, deactivated: 2 })]);
    const insert = db.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.property_listings"));
    expect(insert?.[0]).toContain("ON CONFLICT (id) DO UPDATE");
    expect(insert?.[1][0]).toBe("bolha:sale:123");
    expect(db.query.mock.calls.find(([sql]) => sql.includes("UPDATE public.property_listings SET active = false"))?.[1]).toEqual(["bolha", "sale", ["bolha:sale:123"]]);
    expect(db.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("preserves unseen ads when capped by pages or listing count", async () => {
    for (const page of [
      { listingUrls: [listing.url], nextPageUrl: "https://www.bolha.com/search?page=2" },
      { listingUrls: [listing.url, "https://www.bolha.com/house-456"], nextPageUrl: null },
    ]) {
      const db = database();
      const source = adapter();
      source.parseSearchPage = () => page;
      const result = await ingestListings(db.pool, { sources: ["bolha"], transactionTypes: ["sale"], maxPages: 1, maxListings: 1 }, { adapters: { bolha: source }, fetchHtml: fetchPages() });
      expect(result.summaries[0]).toMatchObject({ status: "success", saved: 1, complete: false, deactivated: 0 });
      expect(db.query.mock.calls.some(([sql]) => sql.includes("SET active = false"))).toBe(false);
    }
  });

  it("does not write or retire data after a network or parser failure", async () => {
    const db = database();
    const fetchHtml = vi.fn().mockResolvedValueOnce(JSON.stringify({ listingUrls: [listing.url], nextPageUrl: null })).mockRejectedValueOnce(new Error("HTTP 403"));
    const result = await ingestListings(db.pool, { sources: ["bolha"], transactionTypes: ["sale"] }, { adapters: { bolha: adapter() }, fetchHtml });
    expect(result.summaries[0]).toMatchObject({ status: "failed", saved: 0, complete: false, error: "HTTP 403" });
    expect(db.query.mock.calls.some(([sql]) => sql.includes("INSERT") || sql.includes("UPDATE"))).toBe(false);
  });

  it("keeps ambiguous skipped catalogue entries from triggering retirement", async () => {
    const db = database();
    const source = adapter();
    source.parseListing = () => null;
    const result = await ingestListings(db.pool, { sources: ["bolha"], transactionTypes: ["sale"] }, { adapters: { bolha: source }, fetchHtml: fetchPages() });
    expect(result.summaries[0]).toMatchObject({ status: "success", saved: 0, skipped: 1, complete: false });
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET active = false"))).toBe(false);
  });

  it("rolls back writes and unlocks after a persistence error", async () => {
    const db = database();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO")) throw new Error("DB write failed");
      return { rows: sql.includes("pg_try_advisory_lock") ? [{ locked: true }] : [], rowCount: 1 };
    });
    const result = await ingestListings(db.pool, { sources: ["bolha"], transactionTypes: ["sale"] }, { adapters: { bolha: adapter() }, fetchHtml: fetchPages() });
    expect(result.summaries[0]).toMatchObject({ status: "failed", saved: 0, error: "DB write failed" });
    expect(db.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(db.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_unlock"))).toBe(true);
  });

  it("rejects a second simultaneous import", async () => {
    const db = database();
    db.query.mockResolvedValue({ rows: [{ locked: false }], rowCount: 1 });
    const fetchHtml = fetchPages();
    await expect(ingestListings(db.pool, { sources: ["bolha"] }, { adapters: { bolha: adapter() }, fetchHtml })).rejects.toMatchObject({ statusCode: 409 });
    expect(fetchHtml).not.toHaveBeenCalled();
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("rejects unavailable sources before opening a database connection", async () => {
    const db = database();
    await expect(ingestListings(db.pool, { sources: ["nepremicnine-net"] })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  it("rejects pagination loops without retiring ads", async () => {
    const db = database();
    const result = await ingestListings(db.pool, { sources: ["bolha"], transactionTypes: ["sale"], maxPages: 2 }, { adapters: { bolha: adapter() }, fetchHtml: fetchPages("https://www.bolha.com/search") });
    expect(result.summaries[0]).toMatchObject({ status: "failed", error: "Source pagination repeated a page" });
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET active = false"))).toBe(false);
  });
});

describe("listing import boundaries", () => {
  it("defaults to accessible sources and rejects malformed options", () => {
    expect(validateListingIngestOptions()).toEqual({ sources: ["bolha"], transactionTypes: ["sale", "rent"], maxPages: 1, maxListings: 50 });
    expect(() => validateListingIngestOptions({ sources: [] })).toThrow();
    expect(() => validateListingIngestOptions({ transactionTypes: ["sale", "sale"] })).toThrow();
    expect(() => validateListingIngestOptions({ maxPages: 0 })).toThrow();
    expect(() => validateListingIngestOptions({ maxListings: 2001 })).toThrow();
  });

  it("rejects upstream links that leave the source host", () => {
    for (const url of ["http://www.bolha.com/listing", "https://www.bolha.com.attacker.test/listing", "https://www.bolha.com@localhost/listing", "https://www.bolha.com:8443/listing"]) {
      expect(() => assertListingSourceUrl(url, adapter())).toThrow();
    }
  });

  it("detects challenge HTML, retries 429, and refuses redirects outside the source", async () => {
    const get = vi.spyOn(axios, "get");
    const wait = vi.fn().mockResolvedValue(undefined);
    try {
      get.mockResolvedValueOnce({ status: 200, data: '<title>Just a moment...</title><div id="cf-chl-test">', headers: {} });
      await expect(createListingFetcher(wait)(listing.url, adapter())).rejects.toThrow("access challenge");
      get.mockResolvedValueOnce({ status: 429, data: "", headers: { "retry-after": "2" } }).mockResolvedValueOnce({ status: 200, data: "<html>ad</html>", headers: {} });
      await expect(createListingFetcher(wait)(listing.url, adapter())).resolves.toBe("<html>ad</html>");
      expect(wait).toHaveBeenCalledWith(2000);
      get.mockResolvedValueOnce({ status: 302, headers: { location: "https://localhost/private" } });
      await expect(createListingFetcher(wait)(listing.url, adapter())).rejects.toThrow("outside Bolha");
    } finally {
      get.mockRestore();
    }
  });
});
