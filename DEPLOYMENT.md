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
3. Copies the Compose/Caddy configuration to the VM over SSH.
4. Starts the new image and waits for its authenticated `/ready` check, which
   also verifies the Aiven connection.
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

## Domain and HTTPS

The initial deployment uses `SITE_ADDRESS=:80`, so it is available over plain
HTTP at the VM's IP address. Do not send the API key over an untrusted network
until a domain and HTTPS are configured.

To enable HTTPS:

1. Point a domain or subdomain's `A` record to `46.224.27.216`.
2. Change `SITE_ADDRESS` in `/opt/property-scraper/.env` from `:80` to that
   hostname.
3. Redeploy Caddy:

```bash
ssh deploy@46.224.27.216
cd /opt/property-scraper
docker compose -f compose.yaml up -d caddy
```

Caddy obtains and renews the TLS certificate automatically.

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

## References

- [Hetzner Docker CE image](https://docs.hetzner.com/cloud/apps/list/docker-ce/)
- [Hetzner server overview](https://docs.hetzner.com/cloud/servers/overview/)
- [GitHub container publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [Caddy reverse proxy](https://caddyserver.com/docs/quick-starts/reverse-proxy)
