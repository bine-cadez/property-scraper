import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";

function keysMatch(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);

  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export function registerGlobalAuth(
  app: FastifyInstance,
  authKey: string,
  publicPathPrefixes: readonly string[] = [],
): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    const isPublicPath = publicPathPrefixes.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
    if (isPublicPath) return;

    const receivedKey = request.headers["x-api-key"];

    if (typeof receivedKey !== "string" || !keysMatch(receivedKey, authKey)) {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "A valid x-api-key header is required",
        statusCode: 401,
      });
    }
  });
}
