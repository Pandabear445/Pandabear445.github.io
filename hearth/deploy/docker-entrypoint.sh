#!/bin/sh
# Container entrypoint: makes sure Hearth never runs as root.
#
# docker-compose.yml starts the container as uid 1000 ("node"), so this just starts Hearth.
# If the container is started as root instead (plain `docker run`, or an older docker-compose.yml without a
# `user:` line — the update tool never replaces your docker-compose.yml), it first gives the data folder to
# uid 1000 (images before this change wrote it as root), then drops root for good and starts Hearth.
set -eu
if [ "$(id -u)" = 0 ]; then
  data="${DATA_DIR:-/data}"
  mkdir -p "$data"
  # Only touches what isn't owned by uid 1000 yet, so this is instant after the first start.
  find "$data" -xdev \( ! -user 1000 -o ! -group 1000 \) -exec chown -h 1000:1000 {} +
  # Switch to uid/gid 1000, clear supplementary groups and inheritable capabilities, and forbid regaining
  # privileges (setuid binaries, file capabilities) for the rest of the container's life.
  exec setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all --no-new-privs -- "$@"
fi
exec "$@"
