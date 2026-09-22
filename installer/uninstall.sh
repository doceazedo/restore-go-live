#!/usr/bin/env bash
set -euo pipefail

say() { printf '%s\n' "$*" >&2; }

REAL_USER=""
if [ "$(id -u)" = 0 ]; then
  REAL_USER="${SUDO_USER:-${DOAS_USER:-}}"
  if [ "$REAL_USER" = root ]; then REAL_USER=""; fi
  if [ -n "$REAL_USER" ]; then
    REAL_HOME="$(getent passwd "$REAL_USER" 2>/dev/null | cut -d: -f6 || true)"
    if [ -n "$REAL_HOME" ] && [ "$REAL_HOME" != "${HOME:-}" ]; then
      case "${XDG_CONFIG_HOME:-}" in
        "$REAL_HOME"/*) ;;
        *) unset XDG_CONFIG_HOME ;;
      esac
      export HOME="$REAL_HOME"
      say "running as root, using $REAL_USER's home ($HOME)"
    fi
  fi
fi

resolve_all() {
  local d="$1" c
  [ -d "$d" ] || return 0
  [ -d "$d/resources" ] && printf '%s\n' "$d/resources"
  printf '%s\n' "$d"
  for c in "$d"/app-*; do
    [ -d "$c/resources" ] && printf '%s\n' "$c/resources"
  done
  return 0
}

case "$(uname -s)" in
  Darwin)
    DATA_DIRS=("$HOME/Library/Application Support/Vencord")
    ROOTS=(
      "/Applications/Discord.app/Contents/Resources"
      "$HOME/Applications/Discord.app/Contents/Resources"
      "/Applications/Discord PTB.app/Contents/Resources"
      "$HOME/Applications/Discord PTB.app/Contents/Resources"
      "/Applications/Discord Canary.app/Contents/Resources"
      "$HOME/Applications/Discord Canary.app/Contents/Resources"
    )
    ;;
  Linux)
    CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
    DATA_DIRS=("$CONFIG/Vencord")
    ROOTS=(
      "$CONFIG/discord" "$CONFIG/discordptb" "$CONFIG/discordcanary"
      /usr/share/discord /usr/lib/discord /usr/lib64/discord
      /opt/discord /opt/Discord "$HOME/.local/share/discord"
      /usr/share/discord-ptb /usr/lib/discord-ptb
      /opt/discord-ptb /opt/DiscordPTB "$HOME/.local/share/discord-ptb"
      /usr/share/discord-canary /usr/lib/discord-canary
      /opt/discord-canary /opt/DiscordCanary "$HOME/.local/share/discord-canary"
    )
    for fp in "com.discordapp.Discord|discord" \
              "com.discordapp.DiscordPTB|discord-ptb" \
              "com.discordapp.DiscordCanary|discord-canary"; do
      fp_id="${fp%%|*}"
      fp_dir="${fp#*|}"
      fp_cfg="$HOME/.var/app/$fp_id/config"
      DATA_DIRS+=("$fp_cfg/Vencord")
      ROOTS+=(
        "$fp_cfg/${fp_dir//-/}"
        "$HOME/.local/share/flatpak/app/$fp_id/current/active/files/$fp_dir"
        "/var/lib/flatpak/app/$fp_id/current/active/files/$fp_dir"
      )
    done
    ;;
  *) say "unsupported platform"; exit 1 ;;
esac

for ROOT in "${ROOTS[@]}"; do
  while IFS= read -r RES; do
    [ -n "$RES" ] || continue
    for SHIM in "$RES/app.asar" "$RES/app"; do
      if [ -d "$SHIM" ] && grep -q "patcher.js" "$SHIM/index.js" 2>/dev/null; then
        rm -rf "$SHIM"
        say "removed shim from $RES"
      fi
    done
    if [ -f "$RES/_app.asar" ] && [ ! -e "$RES/app.asar" ]; then
      mv "$RES/_app.asar" "$RES/app.asar"
      say "restored original app.asar in $RES"
    fi
  done <<< "$(resolve_all "$ROOT")"
done

for DATA in "${DATA_DIRS[@]}"; do
  if [ -d "$DATA/dist" ]; then
    rm -rf "$DATA/dist"
    say "removed $DATA/dist"
  fi
done

say "done! restart Discord"
