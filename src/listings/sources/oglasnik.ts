import { load } from "cheerio";
import { parseAmount } from "../amount.js";
import type {
  ListingCatalogue,
  ListingFetchHtml,
  ListingPriceUnit,
  ListingPropertyType,
  ListingSourceAdapter,
  ListingTransactionType,
  NormalizedListing,
} from "../types.js";

const feedUrl = "https://oglasnik.si/kategorija-oglasa/nepremicnine/feed/";

function plain(html: string): string {
  return load(html).text().replace(/\s+/g, " ").trim();
}

function classify(title: string, body: string): ListingTransactionType | null {
  const side = (value: string): ListingTransactionType | null => {
    const sale = /\bprodaj|\bprodam/i.test(value);
    const rent = /\boddaj|\boddam|\bnajem|\bmese[cč]n/i.test(value);
    if (sale === rent) return null;
    return sale ? "sale" : "rent";
  };
  return side(title) ?? side(`${title} ${body}`);
}

function matchPropertyType(value: string): ListingPropertyType | null {
  if (/garaž|garaz|parkir/i.test(value)) return "garage";
  if (/poslov|pisarn|lokal|skladi/i.test(value)) return "commercial";
  if (/zemlji|parcel|posest/i.test(value)) return "land";
  if (/hiš|hisa/i.test(value)) return "house";
  if (/stanovan/i.test(value)) return "apartment";
  return null;
}

function propertyType(title: string, body: string): ListingPropertyType {
  return matchPropertyType(title)
    ?? matchPropertyType(body.replace(/velikost zemljišč\w*|velikost zemljisc\w*/gi, " "))
    ?? "other";
}

function priceUnit(transactionType: ListingTransactionType, tail: string, body: string): ListingPriceUnit {
  const text = `${tail} ${body}`;
  if (/m\s*(?:2|²)|\/\s*m/i.test(tail)) return "m2";
  if (/mesec|mese[cč]n/i.test(text)) return "month";
  if (/teden/i.test(text)) return "week";
  if (/dnevn/i.test(text)) return "day";
  return transactionType === "sale" ? "total" : "unknown";
}

export function normalizeOglasnikItem(xml: string, requestedType: ListingTransactionType): NormalizedListing | null {
  const item = load(xml, { xml: true });
  const title = item("title").first().text().replace(/\s+/g, " ").trim();
  const link = item("link").first().text().trim();
  const guid = item("guid").first().text().trim();
  const encoded = xml.match(/<content:encoded>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/content:encoded>/i)?.[1]
    ?? item("description").first().text();
  const body = plain(encoded);
  if (!title || !link || !guid) throw new Error("Oglasnik feed item could not be parsed");
  const transaction = classify(title, body);
  if (transaction !== requestedType) return null;
  const url = new URL(link);
  const sourceListingId = guid.match(/[?&]p=(\d+)/)?.[1] ?? null;
  if (url.protocol !== "https:" || url.hostname !== "oglasnik.si" || !url.pathname.startsWith("/oglasi/") || !sourceListingId) {
    throw new Error("Oglasnik feed item could not be parsed (invalid listing identity)");
  }
  url.search = "";
  url.hash = "";
  const priceMatch = body.match(/(\d[\d.\s]*)\s*(?:€|eur)\b([^.\n]{0,48})/i);
  const areaMatch = body.match(/uporabna površina:\s*([\d.,]+)\s*m/i) ?? body.match(/([\d.,]+)\s*m\s*(?:2|²)/i);
  const landMatch = body.match(/(?:zemljišč\w*|zemljisc\w*|parcel\w*)[^0-9]{0,24}([\d.,]+)\s*m/i);
  const location = body.match(/lokacija:\s*([^,.\n]+)/i)?.[1]?.trim() ?? null;
  const article = load(encoded);
  const images = article("img").toArray().flatMap((element) => {
    const src = article(element).attr("src");
    if (!src) return [];
    try {
      const image = new URL(src, url);
      return image.protocol === "https:" ? [image.toString()] : [];
    } catch { return []; }
  });
  return {
    source: "oglasnik",
    sourceListingId,
    url: url.toString(),
    transactionType: requestedType,
    propertyType: propertyType(title, body),
    title,
    description: body || null,
    locationText: location,
    address: null,
    price: priceMatch?.[1] ? parseAmount(priceMatch[1]) : null,
    currency: "EUR",
    priceUnit: priceUnit(requestedType, priceMatch?.[2] ?? "", body),
    areaM2: parseAmount(areaMatch?.[1] ?? null),
    landAreaM2: parseAmount(landMatch?.[1] ?? null),
    rooms: null,
    latitude: null,
    longitude: null,
    locationAccuracy: "unknown",
    images: [...new Set(images)].slice(0, 12),
  };
}

async function readOglasnikCatalogue(
  transactionType: ListingTransactionType,
  limits: { maxPages: number; maxListings: number },
  fetchText: ListingFetchHtml,
): Promise<ListingCatalogue> {
  const found = new Map<string, NormalizedListing>();
  let pages = 0;
  let skipped = 0;
  let completeFeed = false;
  let capped = false;
  while (pages < limits.maxPages && found.size < limits.maxListings) {
    const pageUrl = new URL(feedUrl);
    if (pages > 0) pageUrl.searchParams.set("paged", String(pages + 1));
    const xml = await fetchText({ url: pageUrl.toString(), accept: "application/rss+xml, application/xml, text/xml" }, oglasnikAdapter);
    if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) throw new Error("Oglasnik feed could not be parsed");
    const document = load(xml, { xml: true });
    const items = document("item").toArray();
    pages += 1;
    if (items.length === 0) { completeFeed = true; break; }
    for (const element of items) {
      if (found.size >= limits.maxListings) { capped = true; break; }
      const listing = normalizeOglasnikItem(document(element).toString(), transactionType);
      if (!listing) { skipped += 1; continue; }
      found.set(listing.sourceListingId, listing);
    }
    if (capped) break;
    if (items.length < 10) { completeFeed = true; break; }
  }
  const listings = [...found.values()];
  return { listings, pages, skipped, complete: completeFeed && !capped && skipped === 0 && listings.length > 0 };
}

export const oglasnikAdapter: ListingSourceAdapter = {
  key: "oglasnik",
  name: "Oglasnik.si",
  homepage: "https://oglasnik.si",
  priority: 5,
  searchUrl: () => feedUrl,
  parseSearchPage() {
    throw new Error("Oglasnik listings are read from the public RSS feed");
  },
  parseListing() {
    throw new Error("Oglasnik listings are read from the public RSS feed");
  },
  readCatalogue: readOglasnikCatalogue,
};
