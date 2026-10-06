import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = { nodeEnv: "test", host: "127.0.0.1", port: 3000, databaseUrl: "postgres://unused", authKey: "test-password" };
const headers = { "x-api-key": config.authKey };

describe("listing ingest API", () => {
  it("requires authentication before importing ads", async () => {
    const listingsIngest = vi.fn();
    const app = buildApp(config, { end: vi.fn() } as unknown as Pool, { listingsIngest });
    const response = await app.inject({ method: "POST", url: "/ingest/listings", payload: {} });
    expect(response.statusCode).toBe(401);
    expect(listingsIngest).not.toHaveBeenCalled();
    await app.close();
  });

  it("imports sale and rental ads with safe default limits", async () => {
    const result = { retrievedAt: "2026-10-05T12:00:00Z", summaries: [] };
    const listingsIngest = vi.fn().mockResolvedValue(result);
    const database = { end: vi.fn() } as unknown as Pool;
    const app = buildApp(config, database, { listingsIngest });
    const response = await app.inject({ method: "POST", url: "/ingest/listings", headers, payload: { sources: ["bolha"] } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(listingsIngest).toHaveBeenCalledWith(database, { sources: ["bolha"], transactionTypes: ["sale", "rent"], maxPages: 1, maxListings: 50 }, expect.objectContaining({ onProgress: expect.any(Function) }));
    await app.close();
  });

  it("rejects invalid sources, duplicate types, and limits", async () => {
    const listingsIngest = vi.fn();
    const app = buildApp(config, { end: vi.fn() } as unknown as Pool, { listingsIngest });
    for (const payload of [{ sources: ["unknown"] }, { transactionTypes: ["rent", "rent"] }, { maxPages: 101 }, { maxListings: 0 }, { url: "https://evil.test" }]) {
      expect((await app.inject({ method: "POST", url: "/ingest/listings", headers, payload })).statusCode).toBe(400);
    }
    expect(listingsIngest).not.toHaveBeenCalled();
    await app.close();
  });
});
