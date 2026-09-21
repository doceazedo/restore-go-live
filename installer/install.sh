#!/usr/bin/env bash
set -euo pipefail

REPO="${P2P_REPO:-doceazedo/restore-go-live}"
BASE_URL="${P2P_BASE_URL:-https://github.com/$REPO/releases/latest/download}"
BRANCH="${P2P_DISCORD_BRANCH:-}"
FILES=(patcher.js preload.js renderer.js renderer.css)

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

case "$(uname -s)" in
  Darwin)
    DATA="$HOME/Library/Application Support/Vencord"
    CANDIDATES=(
      "stable|/Applications/Discord.app/Contents/Resources"
      "stable|$HOME/Applications/Discord.app/Contents/Resources"
      "ptb|/Applications/Discord PTB.app/Contents/Resources"
      "canary|/Applications/Discord Canary.app/Contents/Resources"
    )
    ;;
  Linux)
    DATA="${XDG_CONFIG_HOME:-$HOME/.config}/Vencord"
    CANDIDATES=(
      "stable|/usr/share/discord" "stable|/usr/lib/discord"
      "stable|/opt/discord" "stable|/opt/Discord"
      "stable|$HOME/.local/share/discord"
      "ptb|/usr/share/discord-ptb" "ptb|/opt/discord-ptb"
      "canary|/usr/share/discord-canary" "canary|/opt/discord-canary"
      "canary|/usr/lib/discord-canary"
    )
    ;;
  *) die "unsupported platform: $(uname -s)" ;;
esac

FOUND=()
SEEN=""
for entry in "${CANDIDATES[@]}"; do
  label="${entry%%|*}"
  path="${entry#*|}"
  [ -d "$path" ] || continue
  { [ -f "$path/app.asar" ] || [ -f "$path/_app.asar" ]; } || continue
  case "$SEEN" in *"[$label]"*) continue ;; esac
  SEEN="$SEEN[$label]"
  FOUND+=("$entry")
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
mkdir -p "$DATA/dist"
for f in "${FILES[@]}"; do
  curl -fsSL "$BASE_URL/$f" -o "$DATA/dist/$f" || die "could not download $f"
done
printf '{}' > "$DATA/dist/package.json"
say "plugin files installed to $DATA/dist"

ESCAPED=$(printf '%s' "$DATA/dist/patcher.js" | sed 's/\\/\\\\/g; s/"/\\"/g')

for entry in "${TARGETS[@]}"; do
  label="${entry%%|*}"
  RES="${entry#*|}"
  say ""
  say "-> $label"

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

  if [ "$FRESH" = 1 ]; then
    say "   patched"
  else
    say "   already patched, plugin files refreshed"
  fi
done

say ""
say "done! fully quit and reopen Discord :)"
