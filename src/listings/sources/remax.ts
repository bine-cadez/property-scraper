import { load } from "cheerio";
import { parseAmount } from "../amount.js";
import type {
  ListingCatalogue,
  ListingFetchHtml,
  ListingLocationAccuracy,
  ListingPriceUnit,
  ListingPropertyType,
  ListingSourceAdapter,
  ListingTransactionType,
  NormalizedListing,
} from "../types.js";

const searchUrl = "https://www.re-max.si/search/listing-search/docs/search";
const settingsUrl = "https://www.re-max.si/sitesettings/settings.json";
const saleType = 261;
const rentType = 260;
const monthlyGranularity = new Set([597, 3618]);
const areaGranularity = new Set([2010]);
const selectedFields = [
  "ListingKey", "MLSID", "ListingPrice", "HidePricePublic", "TransactionTypeUID", "ListingClass",
  "City", "Province", "RegionalZone", "LocalZone", "StreetName", "StreetNumber", "ShowAddressPublic",
  "Location", "ListingCurrency", "TotalArea", "LivingArea", "LotSize", "NumberOfBedrooms", "TotalNumOfRooms",
  "RentalPriceGranularityUID", "IsForeignProperty", "OnHoldListing", "IsViewable", "CountryID",
  "ListingDescriptions", "ListingImages", "ShortLinks", "GeoDatas",
].map((field) => `content/${field}`).join(",");

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function whole(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function plain(html: string): string | null {
  const value = load(html.replace(/<br\s*\/?>/gi, "\n")).text().replace(/\s+/g, " ").trim();
  return value || null;
}

function priceUnit(transactionType: ListingTransactionType, granularity: number | null): ListingPriceUnit {
  if (granularity !== null && areaGranularity.has(granularity)) return "m2";
  if (transactionType === "rent") return granularity !== null && monthlyGranularity.has(granularity) ? "month" : "unknown";
  return "total";
}

function propertyType(links: JsonObject[], listingClass: number | null): ListingPropertyType {
  const slovenian = links.find((link) => link.LanguageCode === "sl-SI");
  const parts = text(slovenian?.ShortLink)?.split("/") ?? [];
  const slug = parts[parts.indexOf("nepremicninski-oglasi") + 1] ?? "";
  const fromSlug: Record<string, ListingPropertyType> = {
    stanovanje: "apartment", apartma: "apartment", hisa: "house", vila: "house", dvojcek: "house",
    zemljisce: "land", parcela: "land", kmetija: "land", "kmetije-posestva": "land", garaza: "garage", "parkirno-mesto": "garage",
    pisarna: "commercial", "poslovni-prostor": "commercial", lokal: "commercial", restavracija: "commercial",
    skladisce: "commercial", hotel: "commercial", drugo: "other", soba: "other",
  };
  if (fromSlug[slug]) return fromSlug[slug];
  const english = text(links.find((link) => link.ISOLanguageCode === "en")?.ShortLink) ?? "";
  if (english.includes("/apartment")) return "apartment";
  if (english.includes("/house") || english.includes("/villa")) return "house";
  if (english.includes("/land")) return "land";
  if (english.includes("/office") || english.includes("/commercial")) return "commercial";
  if (listingClass === 1) return "commercial";
  if (listingClass === 3) return "land";
  return "other";
}

function coordinates(value: unknown): { latitude: number; longitude: number } | null {
  const point = object(value);
  const pair = Array.isArray(point?.coordinates) ? point.coordinates : null;
  const longitude = typeof pair?.[0] === "number" ? pair[0] : null;
  const latitude = typeof pair?.[1] === "number" ? pair[1] : null;
  if (latitude === null || longitude === null) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

export function normalizeRemaxListing(
  value: unknown,
  requestedType: ListingTransactionType,
  regionId: number,
): NormalizedListing | null {
  const listing = object(value);
  if (!listing) throw new Error("RE/MAX listing could not be parsed (missing listing)");
  const transaction = whole(listing.TransactionTypeUID);
  const expected = requestedType === "sale" ? saleType : rentType;
  if (transaction !== expected || listing.IsForeignProperty === true || listing.OnHoldListing === true || listing.IsViewable === false) return null;
  if (whole(listing.CountryID) !== 49) return null;
  const currency = text(listing.ListingCurrency);
  if (currency && currency !== "EUR") return null;
  const sourceListingId = text(listing.MLSID);
  const links = Array.isArray(listing.ShortLinks) ? listing.ShortLinks.map(object).filter((link): link is JsonObject => link !== null) : [];
  const slovenianLink = text(links.find((link) => link.LanguageCode === "sl-SI")?.ShortLink);
  const url = slovenianLink
    ? new URL(slovenianLink.replace(/^\//, ""), "https://www.re-max.si/").toString()
    : sourceListingId ? `https://www.re-max.si/listings/${encodeURIComponent(sourceListingId)}` : null;
  if (!sourceListingId || !url || new URL(url).hostname !== "www.re-max.si") {
    throw new Error("RE/MAX listing could not be parsed (invalid listing identity)");
  }
  const geos = Array.isArray(listing.GeoDatas) ? listing.GeoDatas.map(object).filter((geo): geo is JsonObject => geo !== null) : [];
  const geo = geos.find((item) => item.LanguageCode === "sl-SI") ?? null;
  const locationText = [geo?.RegionalZone, geo?.City, geo?.LocalZone].map(text).filter((part): part is string => part !== null).join(", ") || null;
  if (!locationText) throw new Error("RE/MAX listing could not be parsed (missing property location)");
  const descriptions = Array.isArray(listing.ListingDescriptions)
    ? listing.ListingDescriptions.map(object).filter((item): item is JsonObject => item !== null) : [];
  const slovenian = descriptions.filter((item) => item.LanguageCode === "sl-SI").map((item) => text(item.Description)).filter((item): item is string => item !== null);
  const description = (slovenian.sort((left, right) => right.length - left.length)[0] ?? text(descriptions[0]?.Description));
  const showAddress = listing.ShowAddressPublic === true;
  const street = [text(listing.StreetName), text(listing.StreetNumber)].filter((part): part is string => part !== null).join(" ");
  const point = coordinates(listing.Location);
  const accuracy: ListingLocationAccuracy = !point ? "unknown" : showAddress ? "exact" : "approximate";
  const images = (Array.isArray(listing.ListingImages) ? listing.ListingImages : []).flatMap((image) => {
    const file = text(object(image)?.FileName);
    if (!file || file.includes("/") || file.includes("\\")) return [];
    return [`https://cdn.gryphtech.com/userimages/${regionId}/Large/${encodeURIComponent(file)}`];
  });
  const hiddenPrice = listing.HidePricePublic === true;
  const granularity = whole(listing.RentalPriceGranularityUID);
  const title = text(geo?.TitleAddress) ?? locationText;
  return {
    source: "re-max",
    sourceListingId,
    url,
    transactionType: requestedType,
    propertyType: propertyType(links, whole(listing.ListingClass)),
    title,
    description: description ? plain(description) : null,
    locationText,
    address: showAddress && street ? street : null,
    price: hiddenPrice ? null : parseAmount(listing.ListingPrice),
    currency: "EUR",
    priceUnit: hiddenPrice ? "unknown" : priceUnit(requestedType, granularity),
    areaM2: parseAmount(listing.TotalArea) ?? parseAmount(listing.LivingArea),
    landAreaM2: parseAmount(listing.LotSize),
    rooms: parseAmount(listing.TotalNumOfRooms) ?? parseAmount(listing.NumberOfBedrooms),
    latitude: point?.latitude ?? null,
    longitude: point?.longitude ?? null,
    locationAccuracy: accuracy,
    images: [...new Set(images)].slice(0, 30),
  };
}

async function readRemaxCatalogue(
  transactionType: ListingTransactionType,
  limits: { maxPages: number; maxListings: number },
  fetchText: ListingFetchHtml,
): Promise<ListingCatalogue> {
  const settings = object(JSON.parse(await fetchText({
    url: settingsUrl, accept: "application/json",
  }, remaxAdapter)));
  if (!settings || settings.CountryCode !== "SI" || whole(settings.CountryID) !== 49 || whole(settings.TenantID) !== 6 || whole(settings.MacroRegionID) === null) {
    throw new Error("RE/MAX settings could not be parsed (expected the public Slovenia site)");
  }
  const regionId = whole(settings.MacroRegionID)!;
  const tenantId = whole(settings.TenantID)!;
  const countryId = whole(settings.CountryID)!;
  const transaction = transactionType === "sale" ? saleType : rentType;
  const found = new Map<string, NormalizedListing>();
  let pages = 0;
  let skipped = 0;
  let skip = 0;
  let total: number | null = null;
  let capped = false;
  while (pages < limits.maxPages && found.size < limits.maxListings) {
    const top = Math.min(25, limits.maxListings - found.size);
    const body = {
      count: true, skip, top,
      filter: `content/TenantId eq ${tenantId} and content/CountryID eq ${countryId} and content/MacroRegionId eq ${regionId} and content/OnHoldListing eq false and content/IsViewable eq true and content/TransactionTypeUID eq ${transaction}`,
      orderby: "content/LastUpdatedOnWeb desc, content/ListingPriceEuro asc",
      select: selectedFields,
    };
    const payload = object(JSON.parse(await fetchText({
      url: searchUrl, method: "POST", body: JSON.stringify(body), contentType: "application/json", accept: "application/json",
    }, remaxAdapter)));
    pages += 1;
    const rows = Array.isArray(payload?.value) ? payload.value : null;
    const count = payload?.["@odata.count"];
    if (!rows || typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new Error("RE/MAX search response could not be parsed");
    }
    total = count;
    if (rows.length === 0) break;
    for (const row of rows) {
      if (found.size >= limits.maxListings) { capped = true; break; }
      const content = object(object(row)?.content);
      const listing = normalizeRemaxListing(content, transactionType, regionId);
      if (!listing) { skipped += 1; continue; }
      found.set(listing.sourceListingId, listing);
    }
    skip += rows.length;
    if (skip >= total) break;
  }
  const listings = [...found.values()];
  const complete = total !== null && listings.length === total && !capped && skipped === 0;
  return { listings, pages, skipped, complete };
}

export const remaxAdapter: ListingSourceAdapter = {
  key: "re-max",
  name: "RE/MAX Slovenia",
  homepage: "https://www.re-max.si",
  priority: 2,
  searchUrl: () => searchUrl,
  parseSearchPage() {
    throw new Error("RE/MAX listings are read from the public search index");
  },
  parseListing() {
    throw new Error("RE/MAX listings are read from the public search index");
  },
  readCatalogue: readRemaxCatalogue,
};
