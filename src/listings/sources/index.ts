import type { ListingSourceAdapter, ListingSourceKey } from "../types.js";
import { bolhaAdapter } from "./bolha.js";

export const listingSources: Array<{
  key: ListingSourceKey;
  name: string;
  homepage: string;
  priority: number;
  enabled: boolean;
  note: string;
}> = [
  {
    key: "nepremicnine-net", name: "Nepremicnine.net", homepage: "https://www.nepremicnine.net", priority: 1, enabled: false,
    note: "Deferred: no verified adapter; the website's published terms require a separate agreement for automated collection and reuse.",
  },
  {
    key: "bolha", name: "Bolha Nepremičnine", homepage: "https://www.bolha.com", priority: 2, enabled: true,
    note: "Slovenian houses offered for sale and rent. Coordinates are labelled with source accuracy; price periods are retained only when explicitly published.",
  },
  {
    key: "si21", name: "SI21 Nepremičnine", homepage: "https://nepremicnine.si21.com", priority: 3, enabled: false,
    note: "Deferred: no verified adapter; the tested public RSS endpoint returned an empty news feed with no property advertisements.",
  },
];

export const listingAdapters: Partial<Record<ListingSourceKey, ListingSourceAdapter>> = {
  bolha: bolhaAdapter,
};
