import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  databaseUrl: "postgres://unused",
  authKey: "test-password",
};

describe("app", () => {
  it("requires the global API key", async () => {
    const database = {
      query: vi.fn(),
      end: vi.fn(),
    } as unknown as Pool;
    const app = buildApp(config, database);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: "Unauthorized",
      statusCode: 401,
    });

    await app.close();
  });

  it("exposes health with the API key without querying the database", async () => {
    const query = vi.fn();
    const end = vi.fn();
    const database = { query, end } as unknown as Pool;
    const app = buildApp(config, database);

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        "x-api-key": config.authKey,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(query).not.toHaveBeenCalled();

    await app.close();
    expect(end).toHaveBeenCalledOnce();
  });

  it("serves Swagger UI and an OpenAPI document", async () => {
    const database = {
      query: vi.fn(),
      end: vi.fn(),
    } as unknown as Pool;
    const app = buildApp(config, database);

    const [uiResponse, documentResponse] = await Promise.all([
      app.inject({ method: "GET", url: "/docs/" }),
      app.inject({ method: "GET", url: "/docs/json" }),
    ]);

    expect(uiResponse.statusCode).toBe(200);
    expect(uiResponse.headers["content-type"]).toContain("text/html");

    expect(documentResponse.statusCode).toBe(200);
    const document = documentResponse.json();
    expect(document).toMatchObject({
      openapi: "3.0.3",
      info: {
        title: "Property Scraper API",
        description: expect.stringContaining("A **building part**"),
      },
      security: [{ apiKey: [] }],
      components: {
        securitySchemes: {
          apiKey: {
            type: "apiKey",
            name: "x-api-key",
            in: "header",
          },
        },
      },
      paths: {
        "/health": {},
        "/ingest/gurs": {},
        "/gurs/parcels/{id}": {},
        "/map/tiles/{layer}/{z}/{x}/{y}.mvt": {},
      },
    });

    const operationMethods = new Set([
      "get",
      "post",
      "put",
      "patch",
      "delete",
    ]);
    const operations = Object.values(
      document.paths as Record<
        string,
        Record<string, { summary?: unknown; description?: unknown }>
      >,
    ).flatMap((path) =>
      Object.entries(path)
        .filter(([method]) => operationMethods.has(method))
        .map(([, operation]) => operation),
    );

    expect(operations).toHaveLength(26);
    for (const operation of operations) {
      expect(operation.summary).toEqual(expect.any(String));
      expect(operation.description).toEqual(expect.any(String));
    }

    await app.close();
  });

  it("returns 404 for unknown routes", async () => {
    const database = {
      query: vi.fn(),
      end: vi.fn(),
    } as unknown as Pool;
    const app = buildApp(config, database);

    const response = await app.inject({
      method: "POST",
      url: "/missing",
      headers: {
        "x-api-key": config.authKey,
      },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("runs a GURS replacement with a sample size of 10,000", async () => {
    const database = {
      query: vi.fn(),
      end: vi.fn(),
    } as unknown as Pool;
    const result = {
      retrievedAt: "2026-07-30T12:00:00.000Z",
      sampleSize: 10_000,
      summaries: [{ source: "KN PARCELE sample", rows: 10_000 }],
    };
    const gursIngest = vi.fn().mockResolvedValue(result);
    const app = buildApp(config, database, { gursIngest });

    const response = await app.inject({
      method: "POST",
      url: "/ingest/gurs",
      headers: {
        "x-api-key": config.authKey,
      },
      payload: {
        sampleSize: 10_000,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(gursIngest).toHaveBeenCalledWith(
      database,
      10_000,
      expect.objectContaining({
        onProgress: expect.any(Function),
      }),
    );

    await app.close();
  });

  it("rejects a GURS sample size above 10,000", async () => {
    const database = {
      query: vi.fn(),
      end: vi.fn(),
    } as unknown as Pool;
    const gursIngest = vi.fn();
    const app = buildApp(config, database, { gursIngest });

    const response = await app.inject({
      method: "POST",
      url: "/ingest/gurs",
      headers: {
        "x-api-key": config.authKey,
      },
      payload: {
        sampleSize: 10_001,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(gursIngest).not.toHaveBeenCalled();

    await app.close();
  });
});
