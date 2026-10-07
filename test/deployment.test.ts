import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

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

  it("schedules the listings refresh on the VM before replacing the API", async () => {
    const [deployScript, refreshScript, deployWorkflow, ingestWorkflow] = await Promise.all([
      readFile(resolve("deploy/deploy.sh"), "utf8"),
      readFile(resolve("deploy/refresh-listings.sh"), "utf8"),
      readFile(resolve(".github/workflows/deploy-production.yml"), "utf8"),
      readFile(resolve(".github/workflows/ingest-listings.yml"), "utf8"),
    ]);

    const install = deployScript.indexOf("\ninstall_listings_refresh_cron\n");
    const pull = deployScript.indexOf("compose pull api caddy");
    expect(install).toBeGreaterThan(-1);
    expect(pull).toBeGreaterThan(install);
    expect(deployScript).toContain(
      "*/5 * * * * /bin/sh /opt/property-scraper/refresh-listings.sh >/dev/null 2>&1 # property-scraper-listings-refresh",
    );

    expect(refreshScript).toContain("node dist/listings/scheduled.js");
    expect(refreshScript).toContain("label=com.docker.compose.project=property-scraper");
    expect(refreshScript).toContain("label=com.docker.compose.service=api");
    expect(refreshScript).toContain("timeout -k 15 240");
    expect(refreshScript).toContain("/opt/property-scraper/listings-refresh.log");
    expect(refreshScript).toContain("flock -n 9");

    expect(deployWorkflow).toContain("deploy/refresh-listings.sh");
    expect(ingestWorkflow).toContain("workflow_dispatch:");
    expect(ingestWorkflow).toContain("/bin/sh /opt/property-scraper/refresh-listings.sh");
    expect(ingestWorkflow).not.toContain("schedule:");
    expect(ingestWorkflow).not.toContain("cron:");

    await execFileAsync("sh", ["-n", "deploy/deploy.sh"]);
    await execFileAsync("sh", ["-n", "deploy/refresh-listings.sh"]);
  });
});
