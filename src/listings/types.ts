export type ListingSourceKey = "nepremicnine-net" | "bolha" | "si21";
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

export type ListingSourceAdapter = {
  key: ListingSourceKey;
  name: string;
  homepage: string;
  priority: number;
  searchUrl: (type: ListingTransactionType) => string;
  parseSearchPage: (html: string, url: string) => ListingSearchPage;
  parseListing: (html: string, url: string, type: ListingTransactionType) => NormalizedListing | null;
};
