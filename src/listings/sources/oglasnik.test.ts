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
});
