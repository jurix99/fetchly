#!/bin/sh
# NAS-friendly entrypoint (LinuxServer.io style): run the app as the host user's
# PUID/PGID so downloaded files aren't owned by root, apply the timezone and
# umask, then drop privileges with gosu. The container starts as root so it can
# adjust ids and ownership, then exec's the app as the unprivileged "abc" user.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-022}"
DL_DIR="${DOWNLOAD_DIR:-/downloads}"
CFG_DIR="${CONFIG_DIR:-/config}"

# --- Timezone (TZ=Europe/London, etc.) ---
if [ -n "${TZ:-}" ] && [ -f "/usr/share/zoneinfo/${TZ}" ]; then
  ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime
  echo "${TZ}" > /etc/timezone
fi

umask "${UMASK}"

# --- Map the "abc" user/group onto the host's PUID/PGID (-o allows duplicates) ---
groupmod -o -g "${PGID}" abc 2>/dev/null || groupadd -o -g "${PGID}" abc
usermod -o -u "${PUID}" -g "${PGID}" abc 2>/dev/null \
  || useradd -o -u "${PUID}" -g "${PGID}" -d "${CFG_DIR}" -s /usr/sbin/nologin abc

# --- Make the data dirs writable by that user ---
#   /config is small -> chown -R (also fixes files from an old root-run image).
#   /downloads can be a huge media library -> chown the top level only (fast);
#   new files are created by abc anyway.
mkdir -p "${DL_DIR}" "${CFG_DIR}"
chown abc:abc "${DL_DIR}"
chown -R abc:abc "${CFG_DIR}" 2>/dev/null || true

export HOME="${CFG_DIR}"
echo "[entrypoint] uid=${PUID} gid=${PGID} tz=${TZ:-UTC} umask=${UMASK}"
exec gosu abc "$@"
