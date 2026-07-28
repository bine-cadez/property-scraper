import "dotenv/config";

import { defineConfig } from "@izumisy/kyrage";

export default defineConfig({
  database: {
    dialect: "postgres",
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5433/property_scraper",
  },
  tables: [],
});
