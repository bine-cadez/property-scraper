import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ingestListings } from "./ingest.js";
import type { ListingSourceAdapter } from "./types.js";

const emptySearchAdapter: ListingSourceAdapter = {
  key: "bolha",
  name: "Bolha",
  homepage: "https://www.bolha.com",
  priority: 2,
  searchUrl: () => "https://www.bolha.com/prodaja-hise",
  parseSearchPage: () => ({ listingUrls: [], nextPageUrl: null }),
  parseListing: () => { throw new Error("An empty search must not fetch a listing"); },
};

function database(unlockError?: Error) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("pg_advisory_unlock") && unlockError) throw unlockError;
    return {
      rows: sql.includes("pg_try_advisory_lock") ? [{ locked: true }] : [],
      rowCount: 0,
    };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool;
  return { pool, query, release };
}

describe("listing import retirement and session cleanup", () => {
  it("preserves existing ads after an unexpectedly empty parsed catalogue", async () => {
    const db = database();
    const fetchHtml = vi.fn().mockResolvedValue("<html>Upstream page with no recognized listing links</html>");

    const result = await ingestListings(db.pool, {
      sources: ["bolha"], transactionTypes: ["sale"],
    }, { adapters: { bolha: emptySearchAdapter }, fetchHtml });

    expect(result.summaries[0]).toMatchObject({
      saved: 0, complete: false, deactivated: 0,
    });
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET active = false"))).toBe(false);
    expect(fetchHtml).toHaveBeenCalledOnce();
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("destroys a connection when session advisory lock release fails", async () => {
    const unlockError = new Error("Advisory unlock query was cancelled");
    const db = database(unlockError);

    // Whether cleanup errors propagate or are reported separately, the session
    // retaining an advisory lock must never return to the idle connection pool.
    await ingestListings(db.pool, {
      sources: ["bolha"], transactionTypes: ["sale"],
    }, {
      adapters: { bolha: emptySearchAdapter },
      fetchHtml: vi.fn().mockResolvedValue("<html>Empty catalogue</html>"),
    }).catch(() => undefined);

    expect(db.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_unlock"))).toBe(true);
    expect(db.release).toHaveBeenCalledExactlyOnceWith(unlockError);
  });
});
