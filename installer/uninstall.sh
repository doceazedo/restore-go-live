#!/usr/bin/env bash
set -euo pipefail

say() { printf '%s\n' "$*" >&2; }

case "$(uname -s)" in
  Darwin) DATA="$HOME/Library/Application Support/Vencord"
          CANDIDATES=("/Applications/Discord.app/Contents/Resources"
                      "/Applications/Discord PTB.app/Contents/Resources"
                      "/Applications/Discord Canary.app/Contents/Resources") ;;
  Linux)  DATA="${XDG_CONFIG_HOME:-$HOME/.config}/Vencord"
          CANDIDATES=(/usr/share/discord /usr/lib/discord /opt/discord /opt/Discord
                      /usr/share/discord-canary /opt/discord-canary
                      "$HOME/.local/share/discord") ;;
  *) say "unsupported platform"; exit 1 ;;
esac

for RES in "${CANDIDATES[@]}"; do
  [ -d "$RES" ] || continue
  if [ -d "$RES/app" ] && grep -q "patcher.js" "$RES/app/index.js" 2>/dev/null; then
    rm -rf "$RES/app"
    say "removed shim from $RES"
  fi
  if [ -f "$RES/_app.asar" ] && [ ! -f "$RES/app.asar" ]; then
    mv "$RES/_app.asar" "$RES/app.asar"
    say "restored original app.asar in $RES"
  fi
done

rm -rf "$DATA/dist"
say "removed $DATA/dist"
say "done! restart Discord"
