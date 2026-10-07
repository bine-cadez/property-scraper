#!/bin/sh
set -eu

: "${IMAGE_REF:?IMAGE_REF must be set}"

compose() {
  IMAGE_REF="$IMAGE_REF" docker compose -f compose.yaml "$@"
}

cron_daemon_running() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet cron 2>/dev/null || systemctl is-active --quiet crond 2>/dev/null; then
      return 0
    fi
  fi
  if ps -C cron >/dev/null 2>&1 || ps -C crond >/dev/null 2>&1; then
    return 0
  fi
  if command -v pgrep >/dev/null 2>&1; then
    if pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

# Schedule the fast listing refresh on this VM. GitHub's */5 cron is
# best-effort and was skipping almost every run. Failure here stops the
# deploy before the running API container is replaced.
install_listings_refresh_cron() {
  script="/opt/property-scraper/refresh-listings.sh"
  marker="property-scraper-listings-refresh"
  # The script appends to listings-refresh.log and mirrors that output on
  # stdout for SSH and GitHub Actions. Discard cron's copy so the deployment
  # user does not receive mail every five minutes.
  entry="*/5 * * * * /bin/sh ${script} >/dev/null 2>&1 # ${marker}"

  if [ ! -f "$script" ]; then
    echo "Missing ${script}; refusing to schedule the listings refresh" >&2
    exit 1
  fi
  if ! command -v crontab >/dev/null 2>&1; then
    echo "crontab is not installed. Install the cron package before deploying." >&2
    exit 1
  fi

  current="$(crontab -l 2>/dev/null || true)"
  filtered="$(printf '%s\n' "$current" | grep -v "${marker}" || true)"
  {
    printf '%s\n' "$filtered" | sed '/^[[:space:]]*$/d'
    printf '%s\n' "$entry"
  } | crontab -

  if cron_daemon_running; then
    return 0
  fi
  echo "The listings refresh crontab entry is installed, but the cron daemon is not running." >&2
  echo "Start it with: sudo systemctl enable --now cron" >&2
  exit 1
}

install_listings_refresh_cron

previous_image=""
api_container="$(compose ps -q api 2>/dev/null || true)"
if [ -n "$api_container" ]; then
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$api_container" 2>/dev/null || true)"
fi

compose pull api caddy

# Apply forward-compatible database migrations from the new image before it
# replaces the currently healthy API container. A migration failure aborts the
# deployment while the previous API version remains online.
compose run --rm --no-deps api node dist/db/migrate.js

compose up -d --remove-orphans

api_container="$(compose ps -q api)"
attempt=1
while [ "$attempt" -le 24 ]; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$api_container" 2>/dev/null || true)"
  if [ "$health" = "healthy" ]; then
    compose ps
    docker image prune -af --filter 'until=168h' >/dev/null
    exit 0
  fi
  if [ "$health" = "unhealthy" ] || [ "$health" = "exited" ] || [ "$health" = "dead" ]; then
    break
  fi
  sleep 5
  attempt=$((attempt + 1))
done

compose logs --tail 100 api >&2 || true

if [ -n "$previous_image" ] && [ "$previous_image" != "$IMAGE_REF" ]; then
  echo "New API image failed readiness; restoring $previous_image" >&2
  IMAGE_REF="$previous_image"
  export IMAGE_REF
  compose up -d --no-deps api
fi

exit 1
