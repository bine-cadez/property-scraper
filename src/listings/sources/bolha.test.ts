import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bolhaAdapter } from "./bolha.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/bolha-${name}.html`, import.meta.url), "utf8");
const saleHtml = fixture("sale");
const rentHtml = fixture("rent");
const saleUrl = "https://www.bolha.com/nepremicnine/ptuj-prostorna-hisa-odlicni-in-mirni-lokaciji-z-velikim-zemljiscem-oglas-16405268";
const rentUrl = "https://www.bolha.com/nepremicnine/lokacija-hise-bratnice-80.00-m2-oglas-16501212";

function changeState(html: string, change: (state: Record<string, any>) => void): string {
  const match = html.match(/window\.__INITIAL_STATE__=(.*);<\/script>/);
  if (!match?.[1]) throw new Error("Invalid test fixture");
  const state = JSON.parse(match[1]) as Record<string, any>;
  change(state);
  return `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};</script>`;
}

describe("Bolha adapter", () => {
  it("scopes house sale and rent searches to all twelve Slovenian regions", () => {
    const sale = new URL(bolhaAdapter.searchUrl("sale"));
    const rent = new URL(bolhaAdapter.searchUrl("rent"));
    expect(sale.pathname).toBe("/prodaja-hise");
    expect(rent.pathname).toBe("/oddaja-hise");
    expect(sale.searchParams.get("geo[locationIds]")?.split(",")).toHaveLength(12);
    expect(rent.searchParams.get("geo[locationIds]")).toBe(sale.searchParams.get("geo[locationIds]"));
    expect(sale.searchParams.get("geo[locationIds]")).not.toContain("30277");
  });

  it("parses verified search state and preserves geography through pagination", () => {
    const url = bolhaAdapter.searchUrl("sale");
    const result = bolhaAdapter.parseSearchPage(fixture("search"), url);
    expect(result.listingUrls).toHaveLength(3);
    expect(result.listingUrls[0]).toBe(saleUrl);
    expect(new URL(result.nextPageUrl!).searchParams.get("page")).toBe("2");
    expect(new URL(result.nextPageUrl!).searchParams.get("geo[locationIds]")).toBe(new URL(url).searchParams.get("geo[locationIds]"));
  });

  it("distinguishes a legitimate empty search from challenges and layout changes", () => {
    const empty = changeState(fixture("search"), (state) => {
      Object.assign(state.browseListingsStore.pageData, { regularListings: [], listingsCount: 0, totalPageCount: 0 });
    });
    expect(bolhaAdapter.parseSearchPage(empty, bolhaAdapter.searchUrl("sale"))).toEqual({ listingUrls: [], nextPageUrl: null });
    expect(() => bolhaAdapter.parseSearchPage("<title>Just a moment...</title>", bolhaAdapter.searchUrl("sale"))).toThrow("could not be parsed");
    const malformed = changeState(fixture("search"), (state) => { state.browseListingsStore.pageData.regularListings = []; });
    expect(() => bolhaAdapter.parseSearchPage(malformed, bolhaAdapter.searchUrl("sale"))).toThrow("no listing links");
    const inconsistent = changeState(empty, (state) => { state.browseListingsStore.pageData.totalPageCount = 40; });
    expect(() => bolhaAdapter.parseSearchPage(inconsistent, bolhaAdapter.searchUrl("sale"))).toThrow("pagination");
    const partial = changeState(fixture("search"), (state) => { delete state.browseListingsStore.pageData.regularListings[1].id; });
    expect(() => bolhaAdapter.parseSearchPage(partial, bolhaAdapter.searchUrl("sale"))).toThrow("malformed regular listing");
  });

  it("reads sale details, land area and published approximate coordinates", () => {
    const result = bolhaAdapter.parseListing(saleHtml, saleUrl, "sale");
    expect(result).toMatchObject({
      source: "bolha", sourceListingId: "16405268", url: saleUrl, transactionType: "sale", propertyType: "house",
      price: 275000, priceUnit: "total", areaM2: 127.4, landAreaM2: 1729, rooms: null,
      locationText: "Podravska, Ptuj, Ptuj", address: null,
      latitude: 46.41311251898276, longitude: 15.851965452716504, locationAccuracy: "approximate",
    });
    expect(result?.images).toHaveLength(2);
    expect(result?.description).not.toContain("<");
  });

  it("preserves rental transaction, rooms and unknown payment period", () => {
    expect(bolhaAdapter.parseListing(rentHtml, rentUrl, "rent")).toMatchObject({
      transactionType: "rent", propertyType: "house", price: 650, priceUnit: "unknown", areaM2: 80, rooms: 2,
      locationText: "Osrednjeslovenska, Ivančna Gorica, Bratnice", locationAccuracy: "approximate",
    });
    const monthly = changeState(rentHtml, (state) => { state.listingDetailStore.pageData.listing.priceFormatted = "650 € /mesec"; });
    expect(bolhaAdapter.parseListing(monthly, rentUrl, "rent")?.priceUnit).toBe("month");
  });

  it("does not substitute seller locations or guess missing map positions", () => {
    const missing = changeState(saleHtml, (state) => {
      state.listingDetailStore.pageData.listing.coordinates = null;
      state.listingDetailStore.pageData.listing.owner = { address: { streetName: "Unrelated seller office", country: "Slovenija" } };
    });
    expect(bolhaAdapter.parseListing(missing, saleUrl, "sale")).toMatchObject({ latitude: null, longitude: null, locationAccuracy: "unknown", address: null });
    const exact = changeState(saleHtml, (state) => { state.listingDetailStore.pageData.listing.isApproximateLocationOnMap = false; });
    expect(bolhaAdapter.parseListing(exact, saleUrl, "sale")?.locationAccuracy).toBe("exact");
    const unknownPrecision = changeState(saleHtml, (state) => { delete state.listingDetailStore.pageData.listing.isApproximateLocationOnMap; });
    expect(bolhaAdapter.parseListing(unknownPrecision, saleUrl, "sale")).toMatchObject({ latitude: 46.41311251898276, longitude: 15.851965452716504, locationAccuracy: "unknown" });
  });

  it("excludes foreign, inactive, mismatched and wanted ads", () => {
    const foreign = changeState(saleHtml, (state) => {
      state.listingDetailStore.pageData.boxes.basicDetailsBox.items[0].definition = "Izven Slovenije - Hrvaška, Pula";
    });
    const wanted = changeState(saleHtml, (state) => { state.listingDetailStore.pageData.listing.title = "Kupim hišo na Ptuju"; });
    const buyer = changeState(saleHtml, (state) => { state.listingDetailStore.pageData.listing.isOwnerSeller = false; });
    const inactive = changeState(saleHtml, (state) => { state.listingDetailStore.pageData.listing.state = "EXPIRED"; });
    for (const html of [foreign, wanted, buyer, inactive]) expect(bolhaAdapter.parseListing(html, saleUrl, "sale")).toBeNull();
    expect(bolhaAdapter.parseListing(saleHtml, saleUrl, "rent")).toBeNull();
  });

  it("does not treat a listing challenge or malformed state as a skipped ad", () => {
    expect(() => bolhaAdapter.parseListing("<title>Just a moment...</title>", saleUrl, "sale")).toThrow("could not be parsed");
    expect(() => bolhaAdapter.parseListing("<script>window.__INITIAL_STATE__={broken};</script>", saleUrl, "sale")).toThrow("invalid public listing data");
  });

  it("distinguishes missing or changed property location fields from explicit foreign ads", () => {
    const missing = changeState(saleHtml, (state) => {
      state.listingDetailStore.pageData.boxes.basicDetailsBox.items = state.listingDetailStore.pageData.boxes.basicDetailsBox.items.filter((item: any) => item.fieldName !== "location");
    });
    const unexpected = changeState(saleHtml, (state) => {
      state.listingDetailStore.pageData.boxes.basicDetailsBox.items[0].definition = "Unknown region, Ptuj";
    });
    expect(() => bolhaAdapter.parseListing(missing, saleUrl, "sale")).toThrow("missing property location");
    expect(() => bolhaAdapter.parseListing(unexpected, saleUrl, "sale")).toThrow("unexpected property location");
    for (const location of ["Izven Slovenije - Hrvaška, Pula", "Zunaj Slovenije - v EU, Berlin", "Zunaj Slovenije - zunaj EU, London", "Hrvaška, Pula"]) {
      const foreign = changeState(saleHtml, (state) => { state.listingDetailStore.pageData.boxes.basicDetailsBox.items[0].definition = location; });
      expect(bolhaAdapter.parseListing(foreign, saleUrl, "sale")).toBeNull();
    }
  });

  it("never turns negative numeric fields into positive values", () => {
    const invalid = changeState(saleHtml, (state) => {
      state.listingDetailStore.pageData.listing.price = "-275000";
      state.listingDetailStore.pageData.boxes.basicDetailsBox.items.find((item: any) => item.fieldName === "livingArea").definition = "-127,40 m²";
    });
    expect(bolhaAdapter.parseListing(invalid, saleUrl, "sale")).toMatchObject({ price: null, areaM2: null });
  });
});
