#!/bin/sh
set -eu

: "${IMAGE_REF:?IMAGE_REF must be set}"

compose() {
  IMAGE_REF="$IMAGE_REF" docker compose -f compose.yaml "$@"
}

previous_image=""
api_container="$(compose ps -q api 2>/dev/null || true)"
if [ -n "$api_container" ]; then
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$api_container" 2>/dev/null || true)"
fi

compose pull api caddy
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
