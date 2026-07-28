## Local development

```bash
cp .env.example .env
pnpm install
docker compose up -d db
pnpm migrate:generate
pnpm migrate:plan
pnpm migrate:apply
pnpm dev
```

## Docker

Run the API and PostgreSQL with:

```bash
docker compose up --build
```

After defining tables in `kyrage.config.ts`, generate and apply migrations:

```bash
docker compose exec api pnpm migrate:generate
docker compose exec api pnpm migrate:apply
```

The `Dockerfile` also contains a minimal `production` target:

```bash
docker build --target production -t property-scraper .
```
