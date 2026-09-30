#!/usr/bin/env bash
# Put one setting into the host's /opt/everpiece/.env (0600) without it touching git, chat, shell history or any
# command line: the value is read with hidden input and sent over SSH stdin. Usage: set-secret.sh <ssh-host> <NAME>
# Then restart the stack: ssh <ssh-host> 'cd /opt/everpiece && docker compose up -d --force-recreate'
set -euo pipefail
HOST="${1:?usage: set-secret.sh <ssh-host> <NAME>}"
NAME="${2:?usage: set-secret.sh <ssh-host> <NAME>}"
[[ "$NAME" =~ ^[A-Z][A-Z0-9_]{1,63}$ ]] || { echo "NAME must be UPPER_SNAKE_CASE" >&2; exit 1; }
# `read` fails at EOF without a trailing newline (piped input) even though VALUE is set; don't let set -e abort on that.
IFS= read -r -s -p "Value for $NAME (input hidden): " VALUE || true; echo
[ -n "$VALUE" ] || { echo "empty value, nothing changed" >&2; exit 1; }
[[ "$VALUE" != *$'\n'* ]] || { echo "value must be one line" >&2; exit 1; }
printf '%s' "$VALUE" | ssh "$HOST" "set -e; cd /opt/everpiece; umask 077; v=\$(cat); t=\$(mktemp .env.XXXXXX); { grep -v '^$NAME=' .env 2>/dev/null || true; printf '%s=%s\n' '$NAME' \"\$v\"; } > \"\$t\"; mv \"\$t\" .env; chmod 600 .env"
unset VALUE
echo "$NAME saved on $HOST (/opt/everpiece/.env)."
