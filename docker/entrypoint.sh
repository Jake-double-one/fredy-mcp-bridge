#!/bin/sh
# Startet als root nur, um das Datenverzeichnis (oft ein Bind-Mount, der root gehört) dem
# Benutzer "node" zu übergeben, und läuft danach ohne Root-Rechte weiter.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown -R node:node "${DATA_DIR:-/data}"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
