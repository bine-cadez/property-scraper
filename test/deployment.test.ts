import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("production deployment", () => {
  it("packages and applies SQL migrations before replacing the API", async () => {
    const [dockerfile, deployScript] = await Promise.all([
      readFile(resolve("Dockerfile"), "utf8"),
      readFile(resolve("deploy/deploy.sh"), "utf8"),
    ]);

    expect(dockerfile).toContain(
      "COPY --from=build /app/migrations ./migrations",
    );

    const migrate = deployScript.indexOf(
      "compose run --rm --no-deps api node dist/db/migrate.js",
    );
    const replaceApi = deployScript.indexOf("compose up -d --remove-orphans");

    expect(migrate).toBeGreaterThan(-1);
    expect(replaceApi).toBeGreaterThan(migrate);
  });
});
