import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { registerGlobalAuth } from "./auth.js";
import type { AppConfig } from "./config.js";
import { registerCors } from "./cors.js";
import { gursRoutes, type GursIngest } from "./routes/gurs.js";
import { healthRoutes } from "./routes/health.js";
import { mapRoutes } from "./routes/map.js";
import { readRoutes } from "./routes/read.js";
import { registerSwagger, SWAGGER_ROUTE_PREFIX } from "./swagger.js";

export type AppDependencies = {
  gursIngest?: GursIngest;
};

export function buildApp(
  config: AppConfig,
  database: Pool,
  dependencies: AppDependencies = {},
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "development" ? "debug" : "info",
    },
  });

  registerSwagger(app);
  registerCors(app, config.corsOrigins ?? []);
  registerGlobalAuth(app, config.authKey, [SWAGGER_ROUTE_PREFIX]);
  app.register(healthRoutes(database));
  app.register(gursRoutes(database, dependencies.gursIngest));
  app.register(readRoutes(database));
  app.register(mapRoutes(database));

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Request failed");
    return reply.send(error);
  });

  app.addHook("onClose", async () => {
    await database.end();
  });

  return app;
}
