import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("listing backfill workflow", () => {
  it("is a manual dispatch on the same host pattern as the five-minute ingest", async () => {
    const [backfill, scheduled] = await Promise.all([
      readFile(".github/workflows/backfill-listings.yml", "utf8"),
      readFile(".github/workflows/ingest-listings.yml", "utf8"),
    ]);
    expect(backfill).toContain("workflow_dispatch:");
    expect(backfill).not.toMatch(/^\s*schedule:/m);
    expect(backfill).toContain("timeout-minutes: 360");
    expect(backfill).toContain("group: listing-ingest");
    expect(backfill).toContain("node dist/listings/backfill.js");
    expect(backfill).toContain('default: "3"');
    expect(backfill).toContain("re-max,kw,oglasnik");
    expect(backfill).not.toContain("bolha");
    expect(scheduled).toContain("workflow_dispatch:");
    expect(scheduled).not.toMatch(/^\s*schedule:/m);
    expect(scheduled).not.toContain("cron:");
    expect(scheduled).toContain("/bin/sh /opt/property-scraper/refresh-listings.sh");
    expect(scheduled).not.toContain("backfill.js");
    expect(scheduled).toContain("group: listing-ingest");
  });
});
