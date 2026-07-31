import type { FastifyInstance } from "fastify";

export function registerCors(
  app: FastifyInstance,
  configuredOrigins: string[],
): void {
  const origins = new Set(configuredOrigins);

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (
      typeof origin === "string" &&
      (origins.has("*") || origins.has(origin))
    ) {
      reply.header(
        "access-control-allow-origin",
        origins.has("*") ? "*" : origin,
      );
      reply.header("vary", "Origin");
      reply.header(
        "access-control-allow-headers",
        "content-type, x-api-key",
      );
      reply.header(
        "access-control-allow-methods",
        "GET, POST, OPTIONS",
      );
      reply.header("access-control-max-age", "86400");
    }
  });
}
