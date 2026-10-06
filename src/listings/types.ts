export type ListingSourceKey =
  | "nepremicnine-net"
  | "re-max"
  | "bolha"
  | "kw"
  | "oglasnik"
  | "si21"
  | "salomon";
export type ListingTransactionType = "sale" | "rent";
export type ListingPropertyType = "house" | "apartment" | "land" | "commercial" | "garage" | "other";
export type ListingPriceUnit = "total" | "month" | "week" | "day" | "m2" | "unknown";
export type ListingLocationAccuracy = "exact" | "approximate" | "unknown";

export type NormalizedListing = {
  source: ListingSourceKey;
  sourceListingId: string;
  url: string;
  transactionType: ListingTransactionType;
  propertyType: ListingPropertyType;
  title: string;
  description: string | null;
  locationText: string | null;
  address: string | null;
  price: number | null;
  currency: "EUR";
  priceUnit: ListingPriceUnit;
  areaM2: number | null;
  landAreaM2: number | null;
  rooms: number | null;
  latitude: number | null;
  longitude: number | null;
  locationAccuracy: ListingLocationAccuracy;
  images: string[];
};

export type ListingSearchPage = {
  listingUrls: string[];
  nextPageUrl: string | null;
};

export type ListingHttpRequest = {
  url: string;
  method?: "GET" | "POST";
  body?: string;
  contentType?: string;
  accept?: string;
};

export type ListingFetchHtml = (request: string | ListingHttpRequest, source: ListingSourceAdapter) => Promise<string>;

export type ListingCatalogue = {
  listings: NormalizedListing[];
  pages: number;
  skipped: number;
  complete: boolean;
};

export type ListingSourceAdapter = {
  key: ListingSourceKey;
  name: string;
  homepage: string;
  priority: number;
  /** Minimum pause before each request. Defaults to 1.5s. KW's robots.txt asks for 30s. */
  minDelayMs?: number;
  searchUrl: (type: ListingTransactionType) => string;
  parseSearchPage: (html: string, url: string) => ListingSearchPage;
  parseListing: (html: string, url: string, type: ListingTransactionType) => NormalizedListing | null;
  /**
   * JSON, RSS, or other catalogues that are not an HTML search page plus detail pages.
   * When present, import uses this instead of searchUrl/parseSearchPage/parseListing.
   */
  readCatalogue?: (
    type: ListingTransactionType,
    limits: { maxPages: number; maxListings: number },
    fetchText: ListingFetchHtml,
  ) => Promise<ListingCatalogue>;
};
