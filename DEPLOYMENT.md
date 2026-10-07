# Hetzner deployment

Production runs as two Docker containers on the Hetzner Cloud VM:

- `api` runs the immutable application image built by GitHub Actions.
- `caddy` is the only public container and proxies HTTP/HTTPS to the API.

PostgreSQL/PostGIS remains on Aiven. The local database dump is a backup only
and is never copied into Git, the Docker image, or the VM.

## Server

- Provider: Hetzner Cloud
- Server: CX23, x86, Nuremberg
- OS: Ubuntu 26.04
- Public IPv4: `46.224.27.216`
- Application directory: `/opt/property-scraper`
- Deployment user: `deploy`

The host firewall permits SSH, HTTP, and HTTPS. Port 3000 is only exposed on
Docker's private network and cannot be reached directly from the internet.

## Deployment flow

For pull requests, GitHub Actions runs tests, typechecking, and the TypeScript
build. For pushes to `main`, it additionally:

1. Builds the production Docker image for `linux/amd64`.
2. Publishes immutable commit and `latest` tags to GHCR.
3. Copies the Compose, Caddy, and listings-refresh scripts to the VM over SSH.
4. Installs the deployment user's five-minute listings cron entry, starts the
   new image, and waits for its authenticated `/ready` check, which also
   verifies the Aiven connection.
5. Restores the previous image automatically if the new container does not
   become healthy.

The VM logs out of GHCR after each deployment. Its Aiven URL and API key stay
only in `/opt/property-scraper/.env`, which is readable by the deployment user
and is not committed to GitHub.

## GitHub secrets

The `production` GitHub environment uses these repository secrets:

- `HETZNER_VM_HOST`
- `HETZNER_VM_USER`
- `HETZNER_VM_SSH_KEY`
- `HETZNER_VM_KNOWN_HOSTS`

The Aiven URL and API key are deliberately not GitHub secrets because GitHub
does not need them to deploy.

## HTTPS

The API uses the free hostname
`property-scraper.46-224-27-216.sslip.io`, which resolves to the VM's public
IP without a separately purchased domain. Caddy obtains and renews its trusted
Let's Encrypt certificate automatically.

- Swagger: <https://property-scraper.46-224-27-216.sslip.io/docs>
- API base URL: <https://property-scraper.46-224-27-216.sslip.io>

Plain HTTP redirects to HTTPS. The hostname depends on the public IP and on the
third-party `sslip.io` DNS service, so an owned domain is preferable if this
becomes a user-facing production service.

To move to an owned domain later:

1. Point the domain or subdomain's `A` record to `46.224.27.216`.
2. Change `SITE_ADDRESS` in `/opt/property-scraper/.env` to that hostname.
3. Redeploy Caddy:

```bash
ssh deploy@46.224.27.216
cd /opt/property-scraper
docker compose -f compose.yaml up -d caddy
```

Caddy will obtain and renew the replacement TLS certificate automatically.

## Operations

Connect and view status or logs:

```bash
ssh deploy@46.224.27.216
cd /opt/property-scraper
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --tail 100
```

Large GURS ingestion runs are safest from the local machine against Aiven.
The VM can run them, but API traffic and ingestion would share its two vCPUs
and 4 GB RAM.

## Listings refresh

Each production deploy installs this cron entry for the `deploy` user, before
the API container is replaced:

```cron
*/5 * * * * /bin/sh /opt/property-scraper/refresh-listings.sh >/dev/null 2>&1 # property-scraper-listings-refresh
```

The script runs `node dist/listings/scheduled.js` in the API container. Cron
discards its own copy of the output. The script appends the same output to
`/opt/property-scraper/listings-refresh.log` and prints it for SSH and for a
manual GitHub Actions run. A second run exits successfully when the refresh
lock is already held. A hung import is stopped after four minutes.

The VM needs the `cron` package and a running cron daemon (`cron` on Ubuntu).
`deploy/deploy.sh` stops before replacing a healthy API container when
`crontab` is missing or the daemon is not running. Start a missing daemon
with `sudo systemctl enable --now cron`, then deploy again.

Watch or pause the schedule from the VM:

```bash
ssh deploy@46.224.27.216
tail -f /opt/property-scraper/listings-refresh.log
crontab -l
```

Removing the `property-scraper-listings-refresh` line pauses the schedule
until the next production deploy, which installs it again. A one-off refresh
from GitHub is the **Ingest listings** workflow's "Run workflow" button.

## References

- [Hetzner Docker CE image](https://docs.hetzner.com/cloud/apps/list/docker-ce/)
- [Hetzner server overview](https://docs.hetzner.com/cloud/servers/overview/)
- [GitHub container publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [Caddy reverse proxy](https://caddyserver.com/docs/quick-starts/reverse-proxy)
