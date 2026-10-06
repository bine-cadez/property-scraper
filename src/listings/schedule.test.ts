import { describe, expect, it } from "vitest";
import { listingImportAlreadyRunning, scheduledListingIngestOptions } from "./schedule.js";

describe("five-minute listing schedule", () => {
  it("refreshes one page of the fast public catalogues", () => {
    expect(scheduledListingIngestOptions).toEqual({
      sources: ["re-max", "oglasnik"],
      transactionTypes: ["sale", "rent"],
      maxPages: 1,
      maxListings: 25,
    });
  });

  it("treats a held import lock as a skip rather than a failed scrape", () => {
    expect(listingImportAlreadyRunning(Object.assign(new Error("busy"), { statusCode: 409 }))).toBe(true);
    expect(listingImportAlreadyRunning(new Error("RE/MAX Slovenia returned HTTP 500"))).toBe(false);
    expect(listingImportAlreadyRunning(null)).toBe(false);
  });
});
