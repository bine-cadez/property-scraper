import { load } from "cheerio";
import type {
  ListingPriceUnit,
  ListingPropertyType,
  ListingSourceAdapter,
  ListingTransactionType,
} from "../types.js";

type JsonObject = Record<string, unknown>;

// Public Bolha region IDs verified against its house search HTML, 2026-10-05.
// The unfiltered categories include Croatian and other foreign properties.
const slovenianRegionIds = [26325, 26324, 26323, 26322, 26321, 26320, 26319, 26318, 26317, 26316, 26315, 26314];
const slovenianRegions = new Set([
  "Gorenjska", "Goriška", "Jugovzhodna Slovenija", "Koroška", "Obalno-kraška",
  "Osrednjeslovenska", "Podravska", "Pomurska", "Posavska", "Primorsko-notranjska", "Savinjska", "Zasavska",
]);

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function plainText(value: unknown): string | null {
  const html = string(value);
  return html ? load(html.replace(/<br\s*\/?>/gi, "\n")).text().replace(/\s+/g, " ").trim() || null : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  if (/(?:^|[^\d])[-−]\s*\d/.test(value)) return null;
  const match = value.replace(/\s/g, "").match(/\d[\d.,]*/);
  if (!match) return null;
  let numeric = match[0];
  if (numeric.includes(",")) numeric = numeric.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(numeric)) numeric = numeric.replace(/\./g, "");
  const parsed = Number(numeric);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pageData(html: string, store: "browseListingsStore" | "listingDetailStore"): JsonObject {
  const $ = load(html);
  const script = $("script").toArray().map((element) => $(element).text())
    .find((text) => /^\s*window\.__INITIAL_STATE__\s*=/.test(text));
  if (!script) throw new Error(`Bolha ${store === "browseListingsStore" ? "search" : "listing"} page could not be parsed (missing public listing data)`);
  try {
    // Parse the site's JSON assignment as data. Never execute source JavaScript.
    const state = object(JSON.parse(script.replace(/^\s*window\.__INITIAL_STATE__\s*=\s*/, "").replace(/;\s*$/, "")));
    const data = object(object(state?.[store])?.pageData);
    if (data) return data;
  } catch { /* Raise the same explicit parser error below for malformed JSON. */ }
  throw new Error(`Bolha ${store === "browseListingsStore" ? "search" : "listing"} page could not be parsed (invalid public listing data)`);
}

function listingUrl(value: unknown, base: string): string | null {
  const path = string(value);
  if (!path) return null;
  try {
    const url = new URL(path, base);
    if (url.protocol !== "https:" || url.hostname !== "www.bolha.com" || !/^\/nepremicnine\/[^/]+-oglas-\d+$/.test(url.pathname)) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function category(value: unknown): { transactionType: ListingTransactionType; propertyType: ListingPropertyType } | null {
  const url = string(object(value)?.url);
  if (!url) return null;
  const match = url.match(/^\/(prodaja|oddaja)-(hise|stanovanja|zemljisca|poslovni-prostori|garaze)\/?$/);
  if (!match) return null;
  const propertyTypes: Record<string, ListingPropertyType> = {
    hise: "house", stanovanja: "apartment", zemljisca: "land", "poslovni-prostori": "commercial", garaze: "garage",
  };
  const propertyType = propertyTypes[match[2] ?? ""];
  return propertyType ? { transactionType: match[1] === "prodaja" ? "sale" : "rent", propertyType } : null;
}

function priceUnit(value: string): ListingPriceUnit {
  if (/m[²2]/i.test(value)) return "m2";
  if (/mesec|mese[cč]|\/\s*month/i.test(value)) return "month";
  if (/teden|tedensk|\/\s*week/i.test(value)) return "week";
  if (/\/\s*dan|dnevno|dnevna|\/\s*day/i.test(value)) return "day";
  if (/skupna cena/i.test(value)) return "total";
  return "unknown";
}

export const bolhaAdapter: ListingSourceAdapter = {
  key: "bolha",
  name: "Bolha Nepremičnine",
  homepage: "https://www.bolha.com/nepremicnine",
  priority: 2,
  searchUrl(transactionType) {
    const url = new URL(transactionType === "sale" ? "/prodaja-hise" : "/oddaja-hise", "https://www.bolha.com");
    url.searchParams.set("geo[locationIds]", slovenianRegionIds.join(","));
    return url.toString();
  },
  parseSearchPage(html, url) {
    const data = pageData(html, "browseListingsStore");
    if (!Array.isArray(data.regularListings) || typeof data.listingsCount !== "number" || !Number.isSafeInteger(data.listingsCount) || data.listingsCount < 0) {
      throw new Error("Bolha search page could not be parsed (missing search results)");
    }
    const listings = [...array(data.promotedListings), ...array(data.userPromotedListings), ...data.regularListings];
    for (const item of data.regularListings) {
      const row = object(item);
      if (!row || row.categorySlug !== "nepremicnine" || typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0
        || !string(row.titleSlug) || !listingUrl(`/nepremicnine/${row.titleSlug}-oglas-${row.id}`, url)) {
        throw new Error("Bolha search page could not be parsed (malformed regular listing)");
      }
    }
    const urls = listings.map((item) => {
      const row = object(item);
      if (!row || row.categorySlug !== "nepremicnine" || typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0 || !string(row.titleSlug)) return null;
      return listingUrl(`/nepremicnine/${row.titleSlug}-oglas-${row.id}`, url);
    }).filter((item): item is string => item !== null);
    if ((urls.length === 0 || data.regularListings.length === 0) && data.listingsCount !== 0) throw new Error("Bolha search page could not be parsed (no listing links)");
    const fields = object(data.fields);
    const currentPage = number(fields?.page);
    const totalPages = number(data.totalPageCount);
    if (currentPage === null || totalPages === null || !Number.isSafeInteger(currentPage) || currentPage < 1 || !Number.isSafeInteger(totalPages)
      || (data.listingsCount > 0 && (totalPages < currentPage || totalPages < 1))
      || (data.listingsCount === 0 && (urls.length > 0 || totalPages > 1 || currentPage !== 1))) {
      throw new Error("Bolha search page could not be parsed (missing pagination)");
    }
    if (data.listingsCount === 0) return { listingUrls: [], nextPageUrl: null };
    let nextPageUrl: string | null = null;
    if (currentPage < totalPages) {
      const next = new URL(url);
      next.searchParams.set("page", String(currentPage + 1));
      nextPageUrl = next.toString();
    }
    return { listingUrls: [...new Set(urls)], nextPageUrl };
  },
  parseListing(html, url, requestedType) {
    const data = pageData(html, "listingDetailStore");
    const listing = object(data.listing);
    if (!listing) throw new Error("Bolha listing page could not be parsed (missing listing)");
    if (listing.state !== "ACTIVE") return null;
    const listingCategory = category(listing.category);
    const title = plainText(listing.title);
    if (!listingCategory || listingCategory.transactionType !== requestedType || listing.isOwnerSeller === false || !title) return null;
    // Offering categories can still contain wrongly categorized wanted ads.
    if (/^(?:kupim|i[sš][cč]em|najamem)\b/i.test(title) || /\((?:kupim|i[sš][cč]em|povpra[sš]evanje)\)\s*$/i.test(title)) return null;
    const boxes = object(data.boxes);
    const fields = array(object(boxes?.basicDetailsBox)?.items).map(object).filter((item): item is JsonObject => item !== null);
    const field = (name: string) => plainText(fields.find((item) => item.fieldName === name)?.definition);
    const locationText = field("location");
    // This is the property's location. The seller's profile address is unrelated.
    if (!locationText) throw new Error("Bolha listing page could not be parsed (missing property location)");
    const region = locationText.split(",")[0]?.trim() ?? "";
    if (/^(?:izven slovenije|zunaj slovenije|hrva[sš]ka)(?:\s|$|,)/i.test(region)) return null;
    if (!slovenianRegions.has(region)) throw new Error("Bolha listing page could not be parsed (unexpected property location)");
    const canonical = listingUrl(data.canonicalUrl, url) ?? listingUrl(listing.url, url);
    const sourceListingId = typeof listing.id === "number" && Number.isSafeInteger(listing.id) && listing.id > 0 ? String(listing.id) : null;
    if (!canonical || !sourceListingId || !canonical.endsWith(`-oglas-${sourceListingId}`)) throw new Error("Bolha listing page could not be parsed (invalid listing identity)");
    const coordinates = object(listing.coordinates);
    const latitude = typeof coordinates?.latitude === "number" && Number.isFinite(coordinates.latitude) && coordinates.latitude >= -90 && coordinates.latitude <= 90 ? coordinates.latitude : null;
    const longitude = typeof coordinates?.longitude === "number" && Number.isFinite(coordinates.longitude) && coordinates.longitude >= -180 && coordinates.longitude <= 180 ? coordinates.longitude : null;
    const hasCoordinates = latitude !== null && longitude !== null;
    const formattedPrice = plainText(listing.priceFormatted) ?? "";
    const unit = priceUnit(`${formattedPrice} ${field("priceType") ?? ""}`);
    const images = array(object(data.media)?.photos).map((photo) => string(object(photo)?.fullUrl)).filter((image): image is string => image !== null)
      .flatMap((image) => { try { const parsed = new URL(image, canonical); return parsed.protocol === "https:" ? [parsed.toString()] : []; } catch { return []; } });
    return {
      source: "bolha", sourceListingId, url: canonical,
      transactionType: listingCategory.transactionType, propertyType: listingCategory.propertyType,
      title, description: plainText(object(boxes?.detailDescriptionBox)?.text), locationText, address: null,
      price: /dogovoru|na zahtevo/i.test(formattedPrice) ? null : number(listing.price), currency: "EUR",
      priceUnit: unit === "unknown" && requestedType === "sale" ? "total" : unit,
      areaM2: number(field("livingArea") ?? field("nettArea")), landAreaM2: number(field("yardArea")), rooms: number(field("numberOfRooms")),
      latitude: hasCoordinates ? latitude : null, longitude: hasCoordinates ? longitude : null,
      locationAccuracy: !hasCoordinates ? "unknown" : listing.isApproximateLocationOnMap === true ? "approximate" : listing.isApproximateLocationOnMap === false ? "exact" : "unknown",
      images: [...new Set(images)],
    };
  },
};
