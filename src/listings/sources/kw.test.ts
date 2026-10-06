import { describe, expect, it } from "vitest";
import { kwAdapter } from "./kw.js";

const search = `
  <a href="https://kwslovenia.com/oglas/531526-prodaja-hisa-dvostanovanjska-podravska-maribor">house</a>
  <a href="https://kwslovenia.com/oglas/500579-oddaja-hisa-samostojna-hrvaska-istarska-zupanija-savudrija">foreign</a>
  <a href="https://kwslovenia.com/oglas/544430-oddaja-stanovanje-2-5-sobno-gorenjska-kranj">rent</a>
  <a href="https://kwslovenia.com/oglasi/prodaja?page=2">2</a>
  <a href="https://kwslovenia.com/oglasi/prodaja?page=8">zadnja</a>
`;

const sale = `
  <title>Prodaja, Hiša</title>
  <div class="pzl-item detail"><div class="offer-type"><span class="tag">Prodaja</span></div><h2>Maribor, Zgornje Radvanje</h2>
  <span class="property-type">Hiša</span><div class="price">885.000 €</div></div>
  <div class="description"><p>Opis hiše.</p></div>
  <ul><li><span>Vrsta nepremičnine:</span> <strong>Hiša</strong></li>
  <li><span>Velikost (neto):</span> <strong>254.9 m<sup>2</sup></strong></li>
  <li><span>Parcela:</span> <strong>596 m<sup>2</sup></strong></li></ul>
  <a class="media-item" href="https://bunny.100m2.si/item/202/a.jpg">photo</a>
  <a class="media-item" href="https://bunny.100m2.si/item/202/a.jpg?class=thumb">thumb</a>
`;

describe("Keller Williams Slovenia adapter", () => {
  it("uses the public sale and rent catalogues and drops foreign slugs before detail fetches", () => {
    expect(kwAdapter.searchUrl("sale")).toBe("https://kwslovenia.com/oglasi/prodaja");
    expect(kwAdapter.searchUrl("rent")).toBe("https://kwslovenia.com/oglasi/oddaja");
    expect(kwAdapter.minDelayMs).toBe(30_000);
    const page = kwAdapter.parseSearchPage(search, kwAdapter.searchUrl("sale"));
    expect(page.listingUrls).toEqual(["https://kwslovenia.com/oglas/531526-prodaja-hisa-dvostanovanjska-podravska-maribor"]);
    expect(page.nextPageUrl).toBe("https://kwslovenia.com/oglasi/prodaja?page=2");
  });

  it("reads price, net area, land, and photos from a listing page", () => {
    const url = "https://kwslovenia.com/oglas/531526-prodaja-hisa-dvostanovanjska-podravska-maribor";
    expect(kwAdapter.parseListing(sale, url, "sale")).toMatchObject({
      source: "kw", sourceListingId: "531526", transactionType: "sale", propertyType: "house",
      price: 885_000, priceUnit: "total", areaM2: 254.9, landAreaM2: 596, rooms: null,
      locationText: "Maribor, Zgornje Radvanje", address: null, locationAccuracy: "unknown",
      description: "Opis hiše.", images: ["https://bunny.100m2.si/item/202/a.jpg"],
    });
    expect(kwAdapter.parseListing(sale, url, "rent")).toBeNull();
  });

  it("keeps a rental monthly only when the page says so, and reads half-rooms from the slug", () => {
    const monthly = sale.replaceAll("Prodaja", "Oddaja").replaceAll("885.000 €", "650 € / mesec").replaceAll("Hiša", "Stanovanje");
    const url = "https://kwslovenia.com/oglas/544430-oddaja-stanovanje-2-5-sobno-gorenjska-kranj";
    expect(kwAdapter.parseListing(monthly, url, "rent")).toMatchObject({
      transactionType: "rent", propertyType: "apartment", price: 650, priceUnit: "month", rooms: 2.5,
    });
    const unspecified = monthly.replace("650 € / mesec", "650 €");
    expect(kwAdapter.parseListing(unspecified, url, "rent")?.priceUnit).toBe("unknown");
    const foreign = sale.replace("Maribor, Zgornje Radvanje", "Savudrija, Hrvaška");
    expect(kwAdapter.parseListing(foreign, url, "sale")).toBeNull();
  });
});
