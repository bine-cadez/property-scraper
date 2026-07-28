import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";

export function healthRoutes(database: Pool): FastifyPluginAsync {
  return async (app) => {
    app.get("/health", async () => ({ status: "ok" }));

    app.get("/ready", async (_request, reply) => {
      try {
        await database.query("select 1");
        return { status: "ready" };
      } catch {
        return reply.code(503).send({ status: "not_ready" });
      }
    });
  };
}

