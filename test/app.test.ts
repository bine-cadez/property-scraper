import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  databaseUrl: "postgres://unused",
};

describe("app", () => {
  it("exposes health without querying the database", async () => {
    const query = vi.fn();
    const end = vi.fn();
    const database = { query, end } as unknown as Pool;
    const app = buildApp(config, database);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(query).not.toHaveBeenCalled();

    await app.close();
    expect(end).toHaveBeenCalledOnce();
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
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
