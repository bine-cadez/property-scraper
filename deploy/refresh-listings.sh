#!/bin/sh
# Refresh the fast listing catalogues inside the production API container.
# deploy/deploy.sh installs this on the Hetzner VM as a five-minute cron job.
# A manual GitHub Actions run executes the same script over SSH.
set -eu

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 077

app_dir="/opt/property-scraper"
log_file="${app_dir}/listings-refresh.log"
lock_file="${app_dir}/listings-refresh.lock"
max_log_bytes=1048576
output_file=""

stamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

write_log() {
  printf '%s\n' "$1" >> "$log_file"
  printf '%s\n' "$1"
}

rotate_log() {
  if [ ! -f "$log_file" ]; then
    return 0
  fi
  size=$(wc -c < "$log_file" | tr -d '[:space:]')
  if [ "$size" -gt "$max_log_bytes" ]; then
    mv "$log_file" "${log_file}.1"
  fi
}

cleanup() {
  if [ -n "$output_file" ]; then
    rm -f "$output_file"
  fi
}

trap cleanup EXIT

if ! command -v flock >/dev/null 2>&1 || ! command -v timeout >/dev/null 2>&1 || ! command -v docker >/dev/null 2>&1; then
  write_log "$(stamp) flock, timeout, and docker must be installed"
  exit 1
fi

exec 9>"$lock_file"
if ! flock -n 9; then
  write_log "$(stamp) listings refresh already running; skipping"
  exit 0
fi

rotate_log
write_log "$(stamp) listings refresh starting"

if ! containers=$(docker ps -q \
  --filter label=com.docker.compose.project=property-scraper \
  --filter label=com.docker.compose.service=api); then
  write_log "$(stamp) docker ps failed"
  exit 1
fi

count=$(printf '%s\n' "$containers" | sed '/^$/d' | wc -l | tr -d '[:space:]')
if [ "$count" -ne 1 ]; then
  write_log "$(stamp) expected one running property-scraper api container, found ${count}"
  exit 1
fi

output_file=$(mktemp)
status=0
timeout -k 15 240 docker exec "$containers" node dist/listings/scheduled.js >"$output_file" 2>&1 || status=$?

if [ -s "$output_file" ]; then
  cat "$output_file" >> "$log_file"
  cat "$output_file"
fi

if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
  write_log "$(stamp) listings refresh timed out after 4 minutes"
  exit "$status"
fi

if [ "$status" -ne 0 ]; then
  write_log "$(stamp) listings refresh failed with status ${status}"
  exit "$status"
fi

write_log "$(stamp) listings refresh finished"
exit 0
