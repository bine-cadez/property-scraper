import { load } from "cheerio";
import { parseAmount } from "../amount.js";
import type {
  ListingPriceUnit,
  ListingPropertyType,
  ListingSourceAdapter,
  ListingTransactionType,
} from "../types.js";

const foreignPlace = /hrva[sš]k|hrvask|italij|srbij|tujin|avstrij|mad[zž]arsk|nem[cč]ij|bosn|črna gora|crna gora|makedon/i;

function field(html: ReturnType<typeof load>, label: string): string | null {
  const item = html("li").toArray().map((element) => html(element)).find((element) => element.find("span").first().text().trim().startsWith(label));
  const value = item?.find("strong").text().replace(/\s+/g, " ").trim();
  return value || null;
}

function propertyType(value: string | null): ListingPropertyType {
  const text = value ?? "";
  if (/garaž|garaz|parkir/i.test(text)) return "garage";
  if (/poslov|pisarn|lokal|hotel|skladi/i.test(text)) return "commercial";
  if (/parcel|zemlji/i.test(text)) return "land";
  if (/hiš|hisa/i.test(text)) return "house";
  if (/stanovan/i.test(text)) return "apartment";
  if (/sob/i.test(text)) return "other";
  return "other";
}

function roomsFromUrl(url: string): number | null {
  const slug = decodeURIComponent(new URL(url).pathname);
  const half = slug.match(/(\d+)-5-sobno/);
  if (half?.[1]) return Number(half[1]) + 0.5;
  const whole = slug.match(/(\d+)-(?:sobno|vec-sobno)/);
  return whole?.[1] ? Number(whole[1]) : null;
}

/** Catalogue cards print a local calendar date such as "Torek, 06.10.2026". */
export function kwCardPublishedAt(text: string): string | null {
  const match = text.replace(/\s+/g, " ").match(/(\d{1,2})\.(\d{1,2})\.(20\d{2})/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString();
}

function priceUnit(transactionType: ListingTransactionType, priceText: string, pageText: string): ListingPriceUnit {
  const around = `${priceText} ${pageText.slice(0, 400)}`;
  if (/m\s*(?:2|²)/i.test(priceText)) return "m2";
  if (/mesec|mese[cč]n|\/\s*mes/i.test(around)) return "month";
  if (/teden|tedensk/i.test(around)) return "week";
  if (/dnevn|\/\s*dan/i.test(around)) return "day";
  return transactionType === "sale" ? "total" : "unknown";
}

export const kwAdapter: ListingSourceAdapter = {
  key: "kw",
  name: "Keller Williams Slovenia",
  homepage: "https://kwslovenia.com",
  priority: 4,
  minDelayMs: 30_000,
  searchUrl(transactionType) {
    return transactionType === "sale" ? "https://kwslovenia.com/oglasi/prodaja" : "https://kwslovenia.com/oglasi/oddaja";
  },
  parseSearchPage(html, url) {
    const page = load(html);
    const current = Number(new URL(url).searchParams.get("page") ?? "1");
    if (!Number.isInteger(current) || current < 1) throw new Error("KW search page could not be parsed (invalid page)");
    const expected = url.includes("/oddaja") ? "oddaja" : "prodaja";
    const listingUrls = page("a[href]").toArray().flatMap((element) => {
      const href = page(element).attr("href");
      if (!href) return [];
      try {
        const parsed = new URL(href, url);
        parsed.search = "";
        parsed.hash = "";
        if (parsed.protocol !== "https:" || parsed.hostname !== "kwslovenia.com") return [];
        if (!new RegExp(`/oglas/\\d+-${expected}-`).test(parsed.pathname)) return [];
        if (foreignPlace.test(decodeURIComponent(parsed.pathname))) return [];
        return [parsed.toString()];
      } catch { return []; }
    });
    const pageNumbers = page("a[href*='page=']").toArray().flatMap((element) => {
      const href = page(element).attr("href");
      if (!href) return [];
      try {
        const parsed = Number(new URL(href, url).searchParams.get("page"));
        return Number.isInteger(parsed) && parsed > 0 ? [parsed] : [];
      } catch { return []; }
    });
    if (listingUrls.length === 0 && (pageNumbers.length > 0 || /just a moment|cf-chl/i.test(html))) {
      throw new Error("KW search page could not be parsed (no listing links)");
    }
    const last = pageNumbers.length ? Math.max(...pageNumbers) : current;
    let nextPageUrl: string | null = null;
    if (current < last) {
      const next = new URL(url);
      next.searchParams.set("page", String(current + 1));
      nextPageUrl = next.toString();
    }
    const publishedAt: Record<string, string> = {};
    for (const element of page(".pzl-item").toArray()) {
      const card = page(element);
      const href = card.find("a[href]").toArray().map((anchor) => page(anchor).attr("href")).find((value) => {
        if (!value) return false;
        try {
          return /\/oglas\/\d+-(?:prodaja|oddaja)-/.test(new URL(value, url).pathname);
        } catch { return false; }
      });
      if (!href) continue;
      let parsed: URL;
      try { parsed = new URL(href, url); } catch { continue; }
      parsed.search = "";
      parsed.hash = "";
      if (parsed.protocol !== "https:" || parsed.hostname !== "kwslovenia.com") continue;
      const iso = kwCardPublishedAt(card.text());
      if (!iso || foreignPlace.test(decodeURIComponent(parsed.pathname))) continue;
      publishedAt[parsed.toString()] = iso;
    }
    const uniqueUrls = [...new Set(listingUrls)];
    for (const listingUrl of Object.keys(publishedAt)) {
      if (!uniqueUrls.includes(listingUrl)) delete publishedAt[listingUrl];
    }
    return { listingUrls: uniqueUrls, nextPageUrl, ...(Object.keys(publishedAt).length ? { publishedAt } : {}) };
  },
  parseListing(html, url, requestedType) {
    const page = load(html);
    const tag = page(".offer-type .tag").first().text().replace(/\s+/g, " ").trim();
    const transaction = /^prodaja$/i.test(tag) ? "sale" : /^oddaja$/i.test(tag) ? "rent" : null;
    if (!transaction || transaction !== requestedType) return null;
    const locationText = page(".pzl-item h2").first().text().replace(/\s+/g, " ").trim() || null;
    if (!locationText) throw new Error("KW listing page could not be parsed (missing property location)");
    if (foreignPlace.test(`${url} ${locationText} ${page("title").text()}`)) return null;
    const id = new URL(url).pathname.match(/\/oglas\/(\d+)/)?.[1];
    if (!id) throw new Error("KW listing page could not be parsed (invalid listing identity)");
    const kind = field(page, "Vrsta nepremičnine") ?? page(".property-type").first().text().trim();
    const priceText = page(".price").first().text().replace(/\s+/g, " ").trim();
    const seenImages = new Set<string>();
    const images = page("a.media-item[href], .pzl-media img[src], .pzl-media img[data-src]").toArray().flatMap((element) => {
      const href = page(element).attr("href") ?? page(element).attr("data-src") ?? page(element).attr("src");
      if (!href) return [];
      try {
        const image = new URL(href, url);
        const identity = `${image.origin}${image.pathname}`;
        if (image.protocol !== "https:" || seenImages.has(identity)) return [];
        seenImages.add(identity);
        return [image.toString()];
      } catch { return []; }
    });
    const description = page(".description").text().replace(/\s+/g, " ").trim() || null;
    return {
      source: "kw",
      sourceListingId: id,
      url,
      transactionType: requestedType,
      propertyType: propertyType(kind),
      title: `${kind || "Nepremičnina"}, ${locationText}`,
      description,
      locationText,
      address: null,
      price: parseAmount(priceText),
      currency: "EUR",
      priceUnit: priceUnit(requestedType, priceText, page(".description").text()),
      areaM2: parseAmount(field(page, "Velikost (neto)") ?? page(".size-neto").first().text()),
      landAreaM2: parseAmount(field(page, "Parcela")),
      rooms: roomsFromUrl(url),
      latitude: null,
      longitude: null,
      locationAccuracy: "unknown",
      images: [...new Set(images)].slice(0, 20),
    };
  },
};
