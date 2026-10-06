import type { ListingSourceAdapter, ListingSourceKey } from "../types.js";
import { bolhaAdapter } from "./bolha.js";
import { kwAdapter } from "./kw.js";
import { oglasnikAdapter } from "./oglasnik.js";
import { remaxAdapter } from "./remax.js";

export type ListingSourceInfo = {
  key: ListingSourceKey;
  name: string;
  homepage: string;
  priority: number;
  enabled: boolean;
  note: string;
};

export const listingSources: ListingSourceInfo[] = [
  {
    key: "nepremicnine-net", name: "Nepremicnine.net", homepage: "https://www.nepremicnine.net", priority: 1, enabled: false,
    note: "Out of scope. The public site returns a Cloudflare challenge to this client, and its terms require a separate agreement for automated collection. The documented agency API needs an activated token and is not a licence for a whole-market copy.",
  },
  {
    key: "re-max", name: "RE/MAX Slovenia", homepage: "https://www.re-max.si", priority: 2, enabled: true,
    note: "Public search index used by www.re-max.si (robots.txt allows /). Slovenia sale and rent ads, with price, area, place, coordinates, and photos. Street addresses are stored only when the listing marks them public.",
  },
  {
    key: "bolha", name: "Bolha Nepremičnine", homepage: "https://www.bolha.com", priority: 3, enabled: false,
    note: "Limited path. The house parser remains available with --sources=bolha, but Bolha has challenged automated clients. A challenge fails that catalogue; it is not bypassed. Disabled unless selected.",
  },
  {
    key: "kw", name: "Keller Williams Slovenia", homepage: "https://kwslovenia.com", priority: 4, enabled: true,
    note: "Public sale and rent catalogues at /oglasi/prodaja and /oglasi/oddaja. robots.txt allows crawling with Crawl-delay 30, and the importer waits 30 seconds between requests. Coordinates are not published on the listing page.",
  },
  {
    key: "oglasnik", name: "Oglasnik.si", homepage: "https://oglasnik.si", priority: 5, enabled: true,
    note: "Public WordPress RSS at /kategorija-oglasa/nepremicnine/feed/. Recent property classifieds only; price and place are read from the article text. Coordinates are not in the feed. Mixed sale and rent items keep a partial import from retiring unseen ads.",
  },
  {
    key: "si21", name: "SI21 Nepremičnine", homepage: "https://nepremicnine.si21.com", priority: 6, enabled: false,
    note: "Out of scope. robots.txt allows the public catalogue with Crawl-delay 10, but listing pages currently return a Cloudflare challenge. That challenge is not bypassed.",
  },
  {
    key: "salomon", name: "Salomon nepremičnine", homepage: "https://www.salomon-nepremicnine.si", priority: 7, enabled: false,
    note: "Out of scope. The agency homepage currently returns a Cloudflare challenge. That challenge is not bypassed.",
  },
];

export const listingSourceKeys = listingSources.map((source) => source.key);

export const listingAdapters: Partial<Record<ListingSourceKey, ListingSourceAdapter>> = {
  "re-max": remaxAdapter,
  bolha: bolhaAdapter,
  kw: kwAdapter,
  oglasnik: oglasnikAdapter,
};

export function splitSourceList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function listingSourcesFor(env: NodeJS.ProcessEnv = process.env): ListingSourceInfo[] {
  const selected = splitSourceList(env.LISTING_SOURCES);
  if (selected.length === 0) return listingSources.map((source) => ({ ...source }));
  const enabled = new Set(selected);
  return listingSources.map((source) => ({ ...source, enabled: enabled.has(source.key) }));
}
