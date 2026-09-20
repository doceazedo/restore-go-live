#!/usr/bin/env bash
set -euo pipefail

REPO="${P2P_REPO:-doceazedo/restore-go-live}"
BASE_URL="${P2P_BASE_URL:-https://github.com/$REPO/releases/latest/download}"
FILES=(patcher.js preload.js renderer.js renderer.css)

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

case "$(uname -s)" in
  Darwin)
    DATA="$HOME/Library/Application Support/Vencord"
    CANDIDATES=(
      "/Applications/Discord.app/Contents/Resources"
      "/Applications/Discord PTB.app/Contents/Resources"
      "/Applications/Discord Canary.app/Contents/Resources"
      "$HOME/Applications/Discord.app/Contents/Resources"
    )
    ;;
  Linux)
    DATA="${XDG_CONFIG_HOME:-$HOME/.config}/Vencord"
    CANDIDATES=(
      /usr/share/discord /usr/lib/discord /opt/discord /opt/Discord
      /usr/share/discord-canary /opt/discord-canary /usr/lib/discord-canary
      /usr/share/discord-ptb /opt/discord-ptb
      "$HOME/.local/share/discord"
    )
    ;;
  *) die "unsupported platform: $(uname -s)" ;;
esac

TARGETS=()
for c in "${CANDIDATES[@]}"; do
  [ -d "$c" ] && { [ -f "$c/app.asar" ] || [ -f "$c/_app.asar" ]; } && TARGETS+=("$c")
done
[ "${#TARGETS[@]}" -gt 0 ] || die "no Discord installation found, install Discord and launch it once first"

say "downloading RestoreGoLive..."
mkdir -p "$DATA/dist"
for f in "${FILES[@]}"; do
  curl -fsSL "$BASE_URL/$f" -o "$DATA/dist/$f" || die "could not download $f"
done
printf '{}' > "$DATA/dist/package.json"
say "plugin files installed to $DATA/dist"

PATCHER="$DATA/dist/patcher.js"
ESCAPED=$(printf '%s' "$PATCHER" | sed 's/\\/\\\\/g; s/"/\\"/g')

for RES in "${TARGETS[@]}"; do
  NAME=$(basename "$(dirname "$(dirname "$RES")")")
  say ""
  say "-> $NAME"

  if [ -f "$RES/_app.asar" ]; then
    say "   already patched by an earlier install, plugin files refreshed"
    continue
  fi

  if [ ! -f "$RES/app.asar" ]; then
    say "   skipped: no app.asar here"
    continue
  fi

  if ! mv "$RES/app.asar" "$RES/_app.asar" 2>/dev/null; then
    say "   FAILED: cannot write to $RES"
    [ "$(uname -s)" = Darwin ] && say "   grant your terminal App Management in System Settings > Privacy & Security, then rerun"
    [ "$(uname -s)" = Linux ] && say "   try again with sudo"
    continue
  fi

  mkdir -p "$RES/app"
  printf 'require("%s");\n' "$ESCAPED" > "$RES/app/index.js"
  printf '{"name":"discord","main":"index.js"}\n' > "$RES/app/package.json"
  say "   patched"
done

say ""
say "done! fully quit and reopen Discord :)"
