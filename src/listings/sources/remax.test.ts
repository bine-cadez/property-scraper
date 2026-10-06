import { describe, expect, it, vi } from "vitest";
import { normalizeRemaxListing, remaxAdapter } from "./remax.js";

const rent = {
  MLSID: "490321062-335",
  TransactionTypeUID: 260,
  ListingClass: 2,
  CountryID: 49,
  IsForeignProperty: false,
  OnHoldListing: false,
  IsViewable: true,
  ListingCurrency: "EUR",
  HidePricePublic: false,
  ShowAddressPublic: false,
  ListingPrice: 820,
  RentalPriceGranularityUID: 597,
  TotalArea: 64.7,
  LotSize: null,
  TotalNumOfRooms: 2,
  StreetName: "Meljski dol",
  StreetNumber: "3",
  Location: { type: "Point", coordinates: [15.66375, 46.56959] },
  ShortLinks: [{ LanguageCode: "sl-SI", ISOLanguageCode: "sl", ShortLink: "sl-si/nepremicninski-oglasi/stanovanje/oddamo/maribor/490321062-335" }],
  GeoDatas: [{ LanguageCode: "sl-SI", RegionalZone: "Podravje", City: "Maribor", LocalZone: "Košaki", TitleAddress: "Maribor, Maribor UE" }],
  ListingDescriptions: [
    { LanguageCode: "en-US", Description: "<p>English only</p>" },
    { LanguageCode: "sl-SI", Description: "<p>Oddamo stanovanje<br>v Mariboru</p>" },
  ],
  ListingImages: [{ FileName: "L_photo.jpg" }],
};

describe("RE/MAX Slovenia adapter", () => {
  it("normalizes a public search document without publishing a hidden street address", () => {
    expect(normalizeRemaxListing(rent, "rent", 49)).toMatchObject({
      source: "re-max", sourceListingId: "490321062-335", transactionType: "rent", propertyType: "apartment",
      url: "https://www.re-max.si/sl-si/nepremicninski-oglasi/stanovanje/oddamo/maribor/490321062-335",
      price: 820, priceUnit: "month", areaM2: 64.7, rooms: 2, address: null,
      locationText: "Podravje, Maribor, Košaki", latitude: 46.56959, longitude: 15.66375, locationAccuracy: "approximate",
      description: "Oddamo stanovanje v Mariboru",
      images: ["https://cdn.gryphtech.com/userimages/49/Large/L_photo.jpg"],
    });
  });

  it("keeps an explicit per-square-metre rent distinct from a total sale price", () => {
    expect(normalizeRemaxListing({ ...rent, RentalPriceGranularityUID: 2010 }, "rent", 49)?.priceUnit).toBe("m2");
    expect(normalizeRemaxListing({ ...rent, TransactionTypeUID: 261, RentalPriceGranularityUID: null }, "sale", 49)?.priceUnit).toBe("total");
    const exact = normalizeRemaxListing({ ...rent, ShowAddressPublic: true }, "rent", 49);
    expect(exact).toMatchObject({ address: "Meljski dol 3", locationAccuracy: "exact" });
  });

  it("drops foreign, hidden, and zero-coordinate ads without inventing a location", () => {
    expect(normalizeRemaxListing({ ...rent, IsForeignProperty: true }, "rent", 49)).toBeNull();
    expect(normalizeRemaxListing({ ...rent, TransactionTypeUID: 261 }, "rent", 49)).toBeNull();
    expect(normalizeRemaxListing({ ...rent, Location: { coordinates: [0, 0] } }, "rent", 49)).toMatchObject({
      latitude: null, longitude: null, locationAccuracy: "unknown",
    });
    expect(normalizeRemaxListing({ ...rent, HidePricePublic: true }, "rent", 49)).toMatchObject({ price: null, priceUnit: "unknown" });
    expect(normalizeRemaxListing({
      ...rent,
      ShortLinks: [{ LanguageCode: "sl-SI", ShortLink: "sl-si/nepremicninski-oglasi/kmetije-posestva/prodamo/velika-nedelja/1" }],
    }, "rent", 49)?.propertyType).toBe("land");
  });

  it("pages the Slovenia search index and stops when the caller caps listings", async () => {
    const fetchText = vi.fn(async (request: { url: string }) => {
      if (request.url.endsWith("/settings.json")) return JSON.stringify({ CountryCode: "SI", CountryID: "49", TenantID: "6", MacroRegionID: "49" });
      return JSON.stringify({ "@odata.count": 2, value: [{ content: rent }, { content: { ...rent, MLSID: "490321062-336" } }] });
    });
    const catalogue = await remaxAdapter.readCatalogue!("rent", { maxPages: 1, maxListings: 1 }, fetchText as never);
    expect(catalogue).toMatchObject({ pages: 1, complete: false, listings: [expect.objectContaining({ sourceListingId: "490321062-335" })] });
    expect(fetchText).toHaveBeenCalledTimes(2);
    const search = fetchText.mock.calls.map(([request]) => request).find((request) => String(request.url).includes("/search"));
    expect(String(search && "body" in search ? search.body : "")).toContain("content/LastUpdatedOnWeb desc");
  });
});
