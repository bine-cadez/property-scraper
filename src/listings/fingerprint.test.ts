import { describe, expect, it } from "vitest";
import { listingFingerprint } from "./fingerprint.js";
import type { NormalizedListing } from "./types.js";

function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    source: "re-max", sourceListingId: "1", url: "https://www.re-max.si/listings/1",
    transactionType: "sale", propertyType: "apartment", title: "Stanovanje",
    description: null, locationText: "Ljubljana, Center", address: null,
    price: 250_000, currency: "EUR", priceUnit: "total", areaM2: 64.4, landAreaM2: null, rooms: 2,
    latitude: 46.05123, longitude: 14.50513, locationAccuracy: "approximate", images: [],
    ...overrides,
  };
}

describe("listing fingerprints", () => {
  it("matches the same place, price, and size across sources and ignores sub-100m coordinate noise", () => {
    const left = listingFingerprint(listing());
    const right = listingFingerprint(listing({ source: "kw", sourceListingId: "9", latitude: 46.0514, longitude: 14.5054, areaM2: 64.2 }));
    expect(left).toBe(right);
    expect(listingFingerprint(listing({ price: 251_000 }))).not.toBe(left);
  });

  it("does not group ads that have no price or place", () => {
    expect(listingFingerprint(listing({ price: null }))).toBeNull();
    expect(listingFingerprint(listing({ latitude: null, longitude: null, locationText: null }))).toBeNull();
    expect(listingFingerprint(listing({ latitude: null, longitude: null, locationText: "  Ljubljana, Šiška " })))
      .toBe(listingFingerprint(listing({ latitude: null, longitude: null, locationText: "ljubljana siska" })));
  });
});
