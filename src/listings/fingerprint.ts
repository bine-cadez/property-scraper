import type { NormalizedListing } from "./types.js";

function place(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Same asking price, size, and place across sources. Missing price or place
 * stays unmatched rather than collapsing unrelated ads.
 */
export function listingFingerprint(listing: NormalizedListing): string | null {
  if (listing.price === null) return null;
  const area = listing.areaM2 ?? listing.landAreaM2;
  const located = listing.latitude !== null && listing.longitude !== null
    ? `${listing.latitude.toFixed(3)},${listing.longitude.toFixed(3)}`
    : place(listing.locationText ?? "");
  if (!located) return null;
  return [
    listing.transactionType,
    listing.propertyType,
    String(Math.round(listing.price)),
    area === null ? "" : String(Math.round(area)),
    located,
  ].join("|");
}
