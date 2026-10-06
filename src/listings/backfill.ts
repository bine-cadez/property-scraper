import { pathToFileURL } from "node:url";
import type { Pool } from "pg";

import { ApiValidationError } from "../gurs/query.js";
import { loadDatabaseConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { collectListingCatalogue, createListingFetcher, saveListings } from "./ingest.js";
import { listingImportAlreadyRunning } from "./schedule.js";
import { listingAdapters, listingSources } from "./sources/index.js";
import { isListingImportStopped } from "./stop.js";
import type { ListingCatalogueLimits, ListingFetchHtml, ListingSourceAdapter, ListingSourceKey, ListingTransactionType } from "./types.js";

export const DEFAULT_BACKFILL_MONTHS = 3;
export const DEFAULT_BACKFILL_MAX_PAGES = 200;
export const DEFAULT_BACKFILL_MAX_LISTINGS = 5_000;
const MAX_BACKFILL_MONTHS = 36;
const MAX_BACKFILL_DAYS = 1_100;
const MAX_BACKFILL_PAGES = 500;
const MAX_BACKFILL_LISTINGS = 20_000;

export const backfillUsage = `Usage: node dist/listings/backfill.js [--months=3] [--lookback-days=N] [--sources=re-max,kw,oglasnik] [--transaction-types=sale,rent] [--max-pages=200] [--max-listings=5000]

Walks the enabled sale and rent catalogues as far back as each source allows and upserts into property_listings. Default lookback is 3 calendar months. Bolha and other disabled sources are refused. Re-running is safe. SIGINT stops after the current request; pages already committed stay saved.`;

export type BackfillOptions = {
  months?: number;
  lookbackDays?: number;
  sources?: ListingSourceKey[];
  transactionTypes?: ListingTransactionType[];
  maxPages?: number;
  maxListings?: number;
  now?: Date;
};

export type ResolvedBackfillPlan = {
  publishedAfter: Date;
  months: number | null;
  lookbackDays: number | null;
  sources: ListingSourceKey[];
  transactionTypes: ListingTransactionType[];
  maxPages: number;
  maxListings: number;
};

export type BackfillSourceSummary = {
  source: ListingSourceKey;
  transactionType: ListingTransactionType;
  status: "success" | "failed" | "stopped";
  pages: number;
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  outsideLookback: number;
  errors: number;
  reachedLookback: boolean;
  lookbackApplied: boolean;
  catalogueExhausted: boolean;
  capped: boolean;
  deactivated: number;
  error?: string;
};

export type BackfillProgress = BackfillSourceSummary & { phase: "page" | "source" };

export type BackfillResult = {
  retrievedAt: string;
  publishedAfter: string;
  months: number | null;
  lookbackDays: number | null;
  stopped: boolean;
  summaries: BackfillSourceSummary[];
};

export type BackfillDependencies = {
  adapters?: Partial<Record<ListingSourceKey, ListingSourceAdapter>>;
  fetchHtml?: ListingFetchHtml;
  signal?: AbortSignal;
  onProgress?: (summary: BackfillProgress) => void;
};

const enabledSourceKeys = listingSources.filter((source) => source.enabled).map((source) => source.key);

function integerInRange(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ApiValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function startOfUtcDay(date: Date): Date {
  const cutoff = new Date(date.getTime());
  cutoff.setUTCHours(0, 0, 0, 0);
  return cutoff;
}

/** Inclusive lower bound. Months are calendar months in UTC; days are 24-hour steps. Both snap to UTC midnight. */
export function backfillCutoff(input: { months?: number; lookbackDays?: number }, now = new Date()): Date {
  if (Number.isNaN(now.getTime())) throw new ApiValidationError("now is not a valid date");
  if (input.months !== undefined && input.lookbackDays !== undefined) {
    throw new ApiValidationError("Pass months or lookback days, not both");
  }
  if (input.lookbackDays !== undefined) {
    const days = integerInRange("lookback days", input.lookbackDays, 1, MAX_BACKFILL_DAYS);
    return startOfUtcDay(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
  }
  const months = input.months === undefined ? DEFAULT_BACKFILL_MONTHS : integerInRange("months", input.months, 1, MAX_BACKFILL_MONTHS);
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return startOfUtcDay(cutoff);
}

export function resolveBackfillPlan(options: BackfillOptions = {}, now = options.now ?? new Date()): ResolvedBackfillPlan {
  if (options.months !== undefined && options.lookbackDays !== undefined) {
    throw new ApiValidationError("Pass months or lookback days, not both");
  }
  const months = options.months;
  const lookbackDays = options.lookbackDays;
  const publishedAfter = backfillCutoff(
    months === undefined && lookbackDays === undefined ? {} : lookbackDays !== undefined ? { lookbackDays } : { months: months ?? DEFAULT_BACKFILL_MONTHS },
    now,
  );
  const known = new Set(listingSources.map((source) => source.key));
  const sources = options.sources ?? enabledSourceKeys;
  if (!Array.isArray(sources) || sources.length === 0 || new Set(sources).size !== sources.length || sources.some((key) => !known.has(key))) {
    throw new ApiValidationError("sources must contain distinct known listing sources");
  }
  const disabled = sources.filter((key) => !enabledSourceKeys.includes(key));
  if (disabled.length) {
    throw new ApiValidationError(`${disabled.join(", ")} is disabled and backfill will not enable it. Enabled sources: ${enabledSourceKeys.join(", ")}`);
  }
  const transactionTypes = options.transactionTypes ?? ["sale", "rent"];
  if (!Array.isArray(transactionTypes) || transactionTypes.length === 0 || new Set(transactionTypes).size !== transactionTypes.length || transactionTypes.some((type) => type !== "sale" && type !== "rent")) {
    throw new ApiValidationError("transactionTypes must contain sale, rent, or both, without duplicates");
  }
  const maxPages = options.maxPages === undefined ? DEFAULT_BACKFILL_MAX_PAGES : integerInRange("maxPages", options.maxPages, 1, MAX_BACKFILL_PAGES);
  const maxListings = options.maxListings === undefined ? DEFAULT_BACKFILL_MAX_LISTINGS : integerInRange("maxListings", options.maxListings, 1, MAX_BACKFILL_LISTINGS);
  return {
    publishedAfter,
    months: lookbackDays === undefined ? (months ?? DEFAULT_BACKFILL_MONTHS) : null,
    lookbackDays: lookbackDays ?? null,
    sources,
    transactionTypes,
    maxPages,
    maxListings,
  };
}

export type ParsedBackfillArguments = { help: true } | { help: false; options: BackfillOptions };

export function parseBackfillArguments(argv: string[]): ParsedBackfillArguments {
  const args = argv.filter((argument) => argument !== "--");
  if (args.includes("--help") || args.includes("-h")) {
    if (args.length !== 1) throw new ApiValidationError("--help does not take other arguments");
    return { help: true };
  }
  const argumentsByName = new Map<string, string>();
  const options: BackfillOptions = {};
  for (const argument of args) {
    const match = /^--(sources|transaction-types|months|lookback-days|max-pages|max-listings)=(.+)$/.exec(argument);
    if (!match?.[1] || !match[2] || argumentsByName.has(match[1])) throw new ApiValidationError(`Invalid or duplicate argument: ${argument}`);
    argumentsByName.set(match[1], match[2]);
  }
  if (argumentsByName.has("sources")) options.sources = argumentsByName.get("sources")!.split(",").map((item) => item.trim()).filter(Boolean) as ListingSourceKey[];
  if (argumentsByName.has("transaction-types")) options.transactionTypes = argumentsByName.get("transaction-types")!.split(",").map((item) => item.trim()).filter(Boolean) as ListingTransactionType[];
  if (argumentsByName.has("months")) options.months = Number(argumentsByName.get("months"));
  if (argumentsByName.has("lookback-days")) options.lookbackDays = Number(argumentsByName.get("lookback-days"));
  if (argumentsByName.has("max-pages")) options.maxPages = Number(argumentsByName.get("max-pages"));
  if (argumentsByName.has("max-listings")) options.maxListings = Number(argumentsByName.get("max-listings"));
  resolveBackfillPlan(options);
  return { help: false, options };
}

function emptySummary(source: ListingSourceKey, transactionType: ListingTransactionType): BackfillSourceSummary {
  return {
    source, transactionType, status: "success", pages: 0, fetched: 0, inserted: 0, updated: 0, skipped: 0,
    outsideLookback: 0, errors: 0, reachedLookback: false, lookbackApplied: false, catalogueExhausted: false,
    capped: false, deactivated: 0,
  };
}

export async function backfillListings(database: Pool, options: BackfillOptions = {}, dependencies: BackfillDependencies = {}): Promise<BackfillResult> {
  const plan = resolveBackfillPlan(options, options.now ?? new Date());
  const adapters = dependencies.adapters ?? listingAdapters;
  for (const key of plan.sources) {
    if (!adapters[key]) throw new ApiValidationError(`${key} is not currently available; see /listings/sources`);
  }
  const fetchHtml = dependencies.fetchHtml ?? (dependencies.signal
    ? createListingFetcher(undefined, { signal: dependencies.signal })
    : createListingFetcher());
  const summaries: BackfillSourceSummary[] = [];
  let stopped = false;
  const client = await database.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", ["property-listings-ingest"]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw Object.assign(new Error("A listing import is already running"), { statusCode: 409 });
    sourceLoop: for (const sourceKey of plan.sources) {
      const source = adapters[sourceKey]!;
      for (const transactionType of plan.transactionTypes) {
        if (dependencies.signal?.aborted) {
          stopped = true;
          break sourceLoop;
        }
        const summary = emptySummary(sourceKey, transactionType);
        try {
          const limits: ListingCatalogueLimits = {
            maxPages: plan.maxPages,
            maxListings: plan.maxListings,
            publishedAfter: plan.publishedAfter,
            onBatch: async (batch) => {
              if (batch.listings.length > 0) {
                const saved = await saveListings(client, batch.listings, sourceKey, transactionType, false);
                if (saved.deactivated !== 0) throw new Error("Backfill refused to deactivate listings");
                summary.inserted += saved.inserted;
                summary.updated += saved.updated;
              }
              summary.pages = batch.pages;
              summary.fetched = batch.fetched;
              summary.skipped = batch.skipped;
              summary.outsideLookback = batch.outsideLookback;
              summary.reachedLookback = batch.reachedLookback;
              summary.lookbackApplied = batch.lookbackApplied;
              summary.catalogueExhausted = batch.exhausted;
              summary.capped = batch.capped;
              dependencies.onProgress?.({ ...summary, phase: "page" });
            },
          };
          if (dependencies.signal) limits.signal = dependencies.signal;
          const walked = await collectListingCatalogue(source, transactionType, limits, fetchHtml);
          summary.pages = Math.max(summary.pages, walked.summary.pages);
          summary.fetched = Math.max(summary.fetched, walked.fetched);
          summary.skipped = Math.max(summary.skipped, walked.summary.skipped);
          summary.outsideLookback = Math.max(summary.outsideLookback, walked.outsideLookback);
          summary.reachedLookback = summary.reachedLookback || walked.reachedLookback;
          summary.lookbackApplied = summary.lookbackApplied || walked.lookbackApplied;
          summary.catalogueExhausted = walked.exhausted;
          summary.capped = walked.capped;
          if (walked.summary.status === "failed") {
            summary.status = "failed";
            summary.errors = 1;
            if (walked.summary.error) summary.error = walked.summary.error;
          }
          summaries.push(summary);
          dependencies.onProgress?.({ ...summary, phase: "source" });
        } catch (error) {
          if (!isListingImportStopped(error)) throw error;
          summary.status = "stopped";
          summaries.push(summary);
          dependencies.onProgress?.({ ...summary, phase: "source" });
          stopped = true;
          break sourceLoop;
        }
      }
    }
    return {
      retrievedAt: new Date().toISOString(),
      publishedAfter: plan.publishedAfter.toISOString(),
      months: plan.months,
      lookbackDays: plan.lookbackDays,
      stopped,
      summaries,
    };
  } finally {
    let releaseError: Error | undefined;
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["property-listings-ingest"]);
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      client.release(releaseError);
    }
  }
}

function backfillInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

async function runBackfillCli(): Promise<void> {
  await import("dotenv/config");
  let parsed: ParsedBackfillArguments;
  try {
    parsed = parseBackfillArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (parsed.help) {
    console.log(backfillUsage);
    return;
  }
  const controller = new AbortController();
  const stop = () => {
    if (controller.signal.aborted) return;
    process.stderr.write(`${JSON.stringify({ status: "stopping" })}\n`);
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  const database = createDatabase(loadDatabaseConfig());
  try {
    const result = await backfillListings(database, parsed.options, {
      signal: controller.signal,
      onProgress: (summary) => process.stderr.write(`${JSON.stringify(summary)}\n`),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.summaries.some((summary) => summary.status === "failed")) process.exitCode = 1;
  } catch (error) {
    if (listingImportAlreadyRunning(error)) {
      process.stderr.write(`${JSON.stringify({ status: "skipped", reason: "A listing import is already running" })}\n`);
      return;
    }
    throw error;
  } finally {
    await database.end();
  }
}

if (backfillInvokedDirectly()) {
  await runBackfillCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
