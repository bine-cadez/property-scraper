export class ListingImportStopped extends Error {
  constructor() {
    super("Listing import stopped");
    this.name = "ListingImportStopped";
  }
}

export function isListingImportStopped(error: unknown): boolean {
  if (error instanceof ListingImportStopped) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "CanceledError") return true;
  return "code" in error && (error as { code?: unknown }).code === "ERR_CANCELED";
}

export function throwIfListingImportStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ListingImportStopped();
}
