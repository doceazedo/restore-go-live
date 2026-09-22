#!/usr/bin/env bash
set -euo pipefail

REPO="${P2P_REPO:-doceazedo/restore-go-live}"
BASE_URL="${P2P_BASE_URL:-https://github.com/$REPO/releases/latest/download}"
BRANCH="${P2P_DISCORD_BRANCH:-}"
FILES=(patcher.js preload.js renderer.js renderer.css)

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

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

fix_owner() {
  [ -n "$REAL_USER" ] || return 0
  [ -e "$1" ] || return 0
  chown -R "$REAL_USER:$(id -gn "$REAL_USER" 2>/dev/null || printf '%s' "$REAL_USER")" "$1" 2>/dev/null || true
}

newest_app() {
  local d="$1" c vers="" best=""
  for c in "$d"/app-*; do
    [ -d "$c/resources" ] || continue
    { [ -e "$c/resources/app.asar" ] || [ -e "$c/resources/_app.asar" ]; } || continue
    vers="$vers${c##*/app-}
"
  done
  [ -n "$vers" ] || return 1
  best="$(printf '%s' "$vers" | sort -V 2>/dev/null | tail -n1)"
  [ -n "$best" ] || best="$(printf '%s' "$vers" | sort | tail -n1)"
  printf '%s/app-%s/resources' "$d" "$best"
}

resolve_res() {
  local d="$1"
  [ -d "$d" ] || return 1
  if [ -e "$d/resources/app.asar" ] || [ -e "$d/resources/_app.asar" ]; then
    printf '%s/resources' "$d"
    return 0
  fi
  if [ -e "$d/app.asar" ] || [ -e "$d/_app.asar" ]; then
    printf '%s' "$d"
    return 0
  fi
  newest_app "$d"
}

case "$(uname -s)" in
  Darwin)
    DATA="$HOME/Library/Application Support/Vencord"
    CANDIDATES=(
      "stable|/Applications/Discord.app/Contents/Resources|"
      "stable|$HOME/Applications/Discord.app/Contents/Resources|"
      "ptb|/Applications/Discord PTB.app/Contents/Resources|"
      "ptb|$HOME/Applications/Discord PTB.app/Contents/Resources|"
      "canary|/Applications/Discord Canary.app/Contents/Resources|"
      "canary|$HOME/Applications/Discord Canary.app/Contents/Resources|"
    )
    ;;
  Linux)
    CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
    DATA="$CONFIG/Vencord"
    CANDIDATES=(
      "stable|$CONFIG/discord|"
      "ptb|$CONFIG/discordptb|"
      "canary|$CONFIG/discordcanary|"
      "stable|/usr/share/discord|"
      "stable|/usr/lib/discord|"
      "stable|/usr/lib64/discord|"
      "stable|/opt/discord|"
      "stable|/opt/Discord|"
      "stable|$HOME/.local/share/discord|"
      "ptb|/usr/share/discord-ptb|"
      "ptb|/usr/lib/discord-ptb|"
      "ptb|/opt/discord-ptb|"
      "ptb|/opt/DiscordPTB|"
      "ptb|$HOME/.local/share/discord-ptb|"
      "canary|/usr/share/discord-canary|"
      "canary|/usr/lib/discord-canary|"
      "canary|/opt/discord-canary|"
      "canary|/opt/DiscordCanary|"
      "canary|$HOME/.local/share/discord-canary|"
    )
    for fp in "stable|com.discordapp.Discord|discord" \
              "ptb|com.discordapp.DiscordPTB|discord-ptb" \
              "canary|com.discordapp.DiscordCanary|discord-canary"; do
      fp_label="${fp%%|*}"
      fp_rest="${fp#*|}"
      fp_id="${fp_rest%%|*}"
      fp_dir="${fp_rest#*|}"
      fp_cfg="$HOME/.var/app/$fp_id/config"
      fp_data="$fp_cfg/Vencord"
      CANDIDATES+=(
        "$fp_label|$fp_cfg/${fp_dir//-/}|$fp_data"
        "$fp_label|$HOME/.local/share/flatpak/app/$fp_id/current/active/files/$fp_dir|$fp_data"
        "$fp_label|/var/lib/flatpak/app/$fp_id/current/active/files/$fp_dir|$fp_data"
      )
    done
    ;;
  *) die "unsupported platform: $(uname -s)" ;;
esac

FOUND=()
SEEN=""
for entry in "${CANDIDATES[@]}"; do
  label="${entry%%|*}"
  rest="${entry#*|}"
  dir="${rest%%|*}"
  tdata="${rest#*|}"
  res="$(resolve_res "$dir" || true)"
  [ -n "$res" ] || continue
  case "$SEEN" in *"[$label]"*) continue ;; esac
  SEEN="$SEEN[$label]"
  FOUND+=("$label|$res|$tdata")
done

[ "${#FOUND[@]}" -gt 0 ] || die "no Discord installation found, install Discord and launch it once first"

if [ "${#FOUND[@]}" -gt 1 ] && [ -z "$BRANCH" ]; then
  DEFAULT=stable
  case "$SEEN" in *"[stable]"*) ;; *) DEFAULT="${FOUND[0]%%|*}" ;; esac

  OPTS=""
  for entry in "${FOUND[@]}"; do
    OPTS="$OPTS${entry%%|*}/"
  done
  OPTS="${OPTS}all"

  if (exec 3</dev/tty) 2>/dev/null; then
    printf 'which Discord installation do you want to patch? (%s) [%s]: ' "$OPTS" "$DEFAULT" >&2
    read -r BRANCH < /dev/tty || BRANCH=""
  else
    say "multiple installs found and no terminal to ask, defaulting to $DEFAULT"
    say "(set P2P_DISCORD_BRANCH to $OPTS to choose)"
  fi
  BRANCH="${BRANCH:-$DEFAULT}"
fi

BRANCH="$(printf '%s' "${BRANCH:-stable}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"

TARGETS=()
if [ "$BRANCH" = all ]; then
  TARGETS=("${FOUND[@]}")
else
  for entry in "${FOUND[@]}"; do
    [ "${entry%%|*}" = "$BRANCH" ] && TARGETS+=("$entry")
  done
  if [ "${#TARGETS[@]}" -eq 0 ]; then
    say "no '$BRANCH' install found, using ${FOUND[0]%%|*} instead"
    TARGETS=("${FOUND[0]}")
  fi
fi

say ""
say "downloading RestoreGoLive..."
STAGE="$DATA/dist"
mkdir -p "$STAGE"
for f in "${FILES[@]}"; do
  curl -fsSL "$BASE_URL/$f" -o "$STAGE/$f" || die "could not download $f"
done
printf '{}' > "$STAGE/package.json"
fix_owner "$DATA"
say "plugin files installed to $STAGE"

for entry in "${TARGETS[@]}"; do
  label="${entry%%|*}"
  rest="${entry#*|}"
  RES="${rest%%|*}"
  TDATA="${rest#*|}"
  [ -n "$TDATA" ] || TDATA="$DATA"

  say ""
  say "-> $label ($RES)"

  if [ "$TDATA" != "$DATA" ]; then
    if ! mkdir -p "$TDATA/dist" 2>/dev/null; then
      say "   FAILED: cannot write to $TDATA"
      continue
    fi
    cp -f "$STAGE/package.json" "$TDATA/dist/package.json"
    for f in "${FILES[@]}"; do
      cp -f "$STAGE/$f" "$TDATA/dist/$f"
    done
    fix_owner "$TDATA"
    say "   plugin files copied to $TDATA/dist"
  fi

  ESCAPED=$(printf '%s' "$TDATA/dist/patcher.js" | sed 's/\\/\\\\/g; s/"/\\"/g')

  FRESH=0
  if [ -f "$RES/app.asar" ]; then
    rm -f "$RES/_app.asar"
    if ! mv "$RES/app.asar" "$RES/_app.asar" 2>/dev/null; then
      say "   FAILED: cannot write to $RES"
      [ "$(uname -s)" = Darwin ] && say "   grant your terminal App Management in System Settings -> Privacy & Security, then rerun"
      [ "$(uname -s)" = Linux ] && say "   try again with sudo"
      continue
    fi
    FRESH=1
  fi

  if [ ! -f "$RES/_app.asar" ]; then
    say "   skipped: no app.asar"
    continue
  fi

  if [ -d "$RES/app" ] && grep -q "patcher.js" "$RES/app/index.js" 2>/dev/null; then
    rm -rf "$RES/app"
  fi

  if ! mkdir -p "$RES/app.asar" 2>/dev/null; then
    say "   FAILED: cannot write to $RES"
    continue
  fi
  printf 'require("%s");\n' "$ESCAPED" > "$RES/app.asar/index.js"
  printf '{"name":"discord","main":"index.js"}\n' > "$RES/app.asar/package.json"
  case "$RES" in "$HOME"/*) fix_owner "$RES/app.asar" ;; esac

  if [ "$FRESH" = 1 ]; then
    say "   patched"
  else
    say "   already patched, plugin files refreshed"
  fi

  case "$RES" in
    /var/lib/flatpak/*) say "   note: a flatpak update will undo this, just rerun the installer" ;;
  esac
done

say ""
say "done! fully quit and reopen Discord :)"
