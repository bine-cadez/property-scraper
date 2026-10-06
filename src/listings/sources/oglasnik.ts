import { load } from "cheerio";
import { parseAmount } from "../amount.js";
import { isListingImportStopped, throwIfListingImportStopped } from "../stop.js";
import type {
  ListingCatalogue,
  ListingCatalogueLimits,
  ListingFetchHtml,
  ListingPriceUnit,
  ListingPropertyType,
  ListingSourceAdapter,
  ListingTransactionType,
  NormalizedListing,
} from "../types.js";

const feedUrl = "https://oglasnik.si/kategorija-oglasa/nepremicnine/feed/";

function plain(html: string): string {
  return load(html.replace(/<br\s*\/?>/gi, "\n")).text().replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").trim();
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
  if (/garaž|garaz/i.test(value)) return "garage";
  if (/poslov|pisarn|lokal|skladi/i.test(value)) return "commercial";
  if (/zemlji|parcel|posest/i.test(value)) return "land";
  if (/hiš|hisa/i.test(value)) return "house";
  if (/stanovan/i.test(value)) return "apartment";
  return null;
}

function propertyType(title: string, body: string): ListingPropertyType {
  if (/\bparkirn/i.test(title) && !/hiš|hisa|stanovan|\bsob[aeo]\b/i.test(title)) return "garage";
  if (/\bsob[aeo]\b/i.test(title) && !/hiš|hisa/i.test(title)) return "apartment";
  const plotLabel = body.replace(/velikost zemljišč\w*|velikost zemljisc\w*|parkirn\w*/gi, " ");
  return matchPropertyType(title) ?? matchPropertyType(plotLabel) ?? "other";
}

function priceUnit(transactionType: ListingTransactionType, tail: string, hasPrice: boolean): ListingPriceUnit {
  if (!hasPrice) return "unknown";
  if (/m\s*(?:2|²)/i.test(tail)) return "m2";
  if (transactionType === "sale") return "total";
  if (/mesec|mese[cč]n/i.test(tail)) return "month";
  if (/teden/i.test(tail)) return "week";
  if (/dnevn/i.test(tail)) return "day";
  return "unknown";
}

export function oglasnikPublishedAt(xml: string): Date | null {
  const raw = load(xml, { xml: true })("pubDate").first().text().trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
    priceUnit: priceUnit(requestedType, priceMatch?.[2] ?? "", Boolean(priceMatch?.[1])),
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
  limits: ListingCatalogueLimits,
  fetchText: ListingFetchHtml,
): Promise<ListingCatalogue> {
  const found = new Map<string, NormalizedListing>();
  let pages = 0;
  let skipped = 0;
  let fetched = 0;
  let outsideLookback = 0;
  let completeFeed = false;
  let endedBy404 = false;
  let capped = false;
  let reachedLookback = false;
  let lookbackApplied = false;
  while (pages < limits.maxPages && found.size < limits.maxListings && !reachedLookback) {
    throwIfListingImportStopped(limits.signal);
    const pageUrl = new URL(feedUrl);
    if (pages > 0) pageUrl.searchParams.set("paged", String(pages + 1));
    let xml: string;
    try {
      xml = await fetchText({ url: pageUrl.toString(), accept: "application/rss+xml, application/xml, text/xml" }, oglasnikAdapter);
    } catch (error) {
      if (isListingImportStopped(error)) throw error;
      // WordPress returns 404 once the short property feed runs out. That is the
      // end of the public archive, not a failed import of the pages already read.
      if (pages > 0 && error instanceof Error && /\bHTTP 404\b/.test(error.message)) {
        // The feed stopped. That is not proof we hold every ad, so do not mark
        // the catalogue complete (a complete import may retire unseen rows).
        endedBy404 = true;
        break;
      }
      throw error;
    }
    if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) throw new Error("Oglasnik feed could not be parsed");
    const document = load(xml, { xml: true });
    const items = document("item").toArray();
    pages += 1;
    if (items.length === 0) { completeFeed = true; break; }
    const pageListings: NormalizedListing[] = [];
    for (const element of items) {
      if (found.size >= limits.maxListings) { capped = true; break; }
      fetched += 1;
      const itemXml = document(element).toString();
      const published = oglasnikPublishedAt(itemXml);
      if (published) lookbackApplied = true;
      if (published && limits.publishedAfter && published.getTime() < limits.publishedAfter.getTime()) {
        outsideLookback += 1;
        skipped += 1;
        reachedLookback = true;
        continue;
      }
      const listing = normalizeOglasnikItem(itemXml, transactionType);
      if (!listing) { skipped += 1; continue; }
      if (!found.has(listing.sourceListingId)) pageListings.push(listing);
      found.set(listing.sourceListingId, listing);
    }
    if (items.length < 10) completeFeed = true;
    if (limits.onBatch) {
      await limits.onBatch({
        listings: pageListings, pages, skipped, fetched, outsideLookback, reachedLookback, lookbackApplied,
        exhausted: completeFeed, capped,
      });
    }
    if (capped || reachedLookback || completeFeed) break;
  }
  if (pages >= limits.maxPages && !completeFeed && !reachedLookback) capped = true;
  const listings = [...found.values()];
  const exhausted = (completeFeed || endedBy404) && !capped;
  return {
    listings, pages, skipped, fetched, outsideLookback, reachedLookback, lookbackApplied, exhausted, capped,
    complete: limits.publishedAfter === undefined && completeFeed && !capped && !reachedLookback && skipped === 0 && listings.length > 0,
  };
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
