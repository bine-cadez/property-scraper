import { describe, expect, it, vi } from "vitest";
import { normalizeOglasnikItem, oglasnikAdapter } from "./oglasnik.js";

const item = `
<item>
  <title>PRODAJA HIŠE</title>
  <link>https://oglasnik.si/oglasi/prodaja-hise/</link>
  <guid>https://oglasnik.si/?post_type=ad_listing&amp;p=30413</guid>
  <content:encoded><![CDATA[<p>Prodaja se samostojna hiša. Lokacija: Selnica ob Dravi.
  Uporabna površina: 181 m2. Velikost zemljišča: 625 m2. Cena: 250.000 EUR.</p>
  <img src="https://oglasnik.si/wp-content/uploads/hisa.jpg" />]]></content:encoded>
</item>`;

const rent = `
<item>
  <title>Dvopostelna soba</title>
  <link>https://oglasnik.si/oglasi/dvopostelna-soba/</link>
  <guid>https://oglasnik.si/?post_type=ad_listing&amp;p=30637</guid>
  <content:encoded><![CDATA[<p>Prenovljeno študentsko dvosobno stanovanje 68 m2. Prednost imajo najemniki.
  Cena: <span>2</span><span>4</span><span>5 EUR</span> na osebo mesečno.</p>]]></content:encoded>
</item>`;

describe("Oglasnik RSS adapter", () => {
  it("reads a sale from the public property feed", () => {
    expect(normalizeOglasnikItem(item, "sale")).toMatchObject({
      source: "oglasnik", sourceListingId: "30413", transactionType: "sale", propertyType: "house",
      url: "https://oglasnik.si/oglasi/prodaja-hise/", price: 250_000, priceUnit: "total",
      areaM2: 181, landAreaM2: 625, locationText: "Selnica ob Dravi", address: null, locationAccuracy: "unknown",
      images: ["https://oglasnik.si/wp-content/uploads/hisa.jpg"],
    });
    expect(normalizeOglasnikItem(item, "rent")).toBeNull();
  });

  it("reads a line-broken sale that names monthly costs but does not state a price", () => {
    const live = `
<item>
  <title>PRODAJA HIŠE</title>
  <link>https://oglasnik.si/oglasi/prodaja-hise/</link>
  <guid>https://oglasnik.si/?post_type=ad_listing&amp;p=30413</guid>
  <content:encoded><![CDATA[<p>Hiša ima garažo in poslovni del.</p>
  <p>Lokacija: Selnica ob Dravi<br />
  Uporabna površina: 181 m2<br />
  Velikost zemljišča: 625 m2</p>
  <p>Mesečni stroški vključno z ogrevanjem so nizki.</p>]]></content:encoded>
</item>`;
    expect(normalizeOglasnikItem(live, "sale")).toMatchObject({
      propertyType: "house", price: null, priceUnit: "unknown",
      areaM2: 181, landAreaM2: 625, locationText: "Selnica ob Dravi",
    });
  });

  it("joins split price digits and treats an explicit monthly rent as monthly", () => {
    expect(normalizeOglasnikItem(rent, "rent")).toMatchObject({
      sourceListingId: "30637", transactionType: "rent", propertyType: "apartment",
      price: 245, priceUnit: "month", areaM2: 68,
    });
  });

  it("does not treat a mixed feed page as a complete sale catalogue", async () => {
    const fetchText = vi.fn(async () => `<rss><channel>${item}${rent}</channel></rss>`);
    const catalogue = await oglasnikAdapter.readCatalogue!("sale", { maxPages: 2, maxListings: 10 }, fetchText as never);
    expect(catalogue).toMatchObject({ pages: 1, skipped: 1, complete: false, listings: [expect.objectContaining({ sourceListingId: "30413" })] });
  });

  it("keeps in-window RSS items and does not request the next page after an older pubDate", async () => {
    const recent = item.replace("</item>", "<pubDate>Thu, 01 Oct 2026 00:00:00 +0000</pubDate></item>");
    const older = item
      .replace("30413", "10001")
      .replace("prodaja-hise/", "stara-hisa/")
      .replace("</item>", "<pubDate>Thu, 01 Jan 2026 00:00:00 +0000</pubDate></item>");
    const fetchText = vi.fn(async (request: { url: string }) => {
      if (request.url.includes("paged=")) throw new Error("next page should not be fetched");
      return `<rss><channel>${recent}${older}</channel></rss>`;
    });
    const catalogue = await oglasnikAdapter.readCatalogue!("sale", {
      maxPages: 4, maxListings: 20, publishedAfter: new Date("2026-07-06T00:00:00.000Z"),
    }, fetchText as never);
    expect(catalogue.listings.map((listing) => listing.sourceListingId)).toEqual(["30413"]);
    expect(catalogue).toMatchObject({ pages: 1, reachedLookback: true, lookbackApplied: true, complete: false, outsideLookback: 1 });
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it("treats a later HTTP 404 as the end of the feed without calling that archive complete", async () => {
    const fullPage = Array.from({ length: 10 }, (_, index) => item
      .replace("30413", String(40_000 + index))
      .replace("/oglasi/prodaja-hise/", `/oglasi/prodaja-hise-${index}/`)).join("");
    const fetchText = vi.fn(async (request: { url: string }) => {
      if (request.url.includes("paged=2")) throw new Error("Oglasnik.si returned HTTP 404");
      return `<rss><channel>${fullPage}</channel></rss>`;
    });
    const catalogue = await oglasnikAdapter.readCatalogue!("sale", { maxPages: 3, maxListings: 50 }, fetchText as never);
    expect(catalogue).toMatchObject({ pages: 1, exhausted: true, complete: false, listings: expect.any(Array) });
    expect(catalogue.listings).toHaveLength(10);
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
});
