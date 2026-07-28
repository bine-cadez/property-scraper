import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AppConfig } from "./config.js";
import { healthRoutes } from "./routes/health.js";

export function buildApp(config: AppConfig, database: Pool): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "development" ? "debug" : "info",
    },
  });

  app.register(healthRoutes(database));

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Request failed");
    return reply.send(error);
  });

  app.addHook("onClose", async () => {
    await database.end();
  });

  return app;
}
