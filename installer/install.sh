#!/usr/bin/env bash
set -euo pipefail

REPO="${P2P_REPO:-doceazedo/restore-go-live}"
BASE_URL="${RGL_RELEASE_URL:-${P2P_BASE_URL:-https://github.com/$REPO/releases/latest/download}}"
FORCE="${P2P_FORCE:-}"
BRANCH="${P2P_DISCORD_BRANCH:-}"
FILES=(main.js preload.js renderer.js)
LEGACY_FILES=(patcher.js preload.js renderer.js renderer.css)

if [ -t 2 ]; then
  C_RESET=$'\033[0m' C_DIM=$'\033[2m' C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_MAGENTA=$'\033[35m' C_CYAN=$'\033[36m' C_BOLD=$'\033[1m'
else
  C_RESET="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW="" C_MAGENTA="" C_CYAN="" C_BOLD=""
fi

FAILED=0
say() { printf '%s\n' "$*" >&2; }
step() { say "  ${C_CYAN}>${C_RESET} $*"; }
ok() { say "  ${C_GREEN}+${C_RESET} $*"; }
warn() { say "  ${C_YELLOW}!${C_RESET} $*"; }
fail() { FAILED=1; say "  ${C_RED}x${C_RESET} $*"; }
die() { fail "$*"; exit 1; }

HAS_TTY=0
if [ -z "${P2P_YES:-}" ] && (exec 3</dev/tty) 2>/dev/null; then HAS_TTY=1; fi

ask() {
  local answer=""
  if [ "$HAS_TTY" = 1 ]; then
    printf '  %s?%s %s %s(%s)%s ' "$C_MAGENTA" "$C_RESET" "$1" "$C_DIM" "$2" "$C_RESET" >&2
    read -r answer < /dev/tty || answer=""
  fi
  answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  printf '%s' "${answer:-$3}"
}

confirm() {
  case "$(ask "$1" "Y/n" y)" in y*) return 0 ;; *) return 1 ;; esac
}

display_name() {
  case "$1" in
    stable) printf 'Discord' ;;
    ptb) printf 'Discord PTB' ;;
    canary) printf 'Discord Canary' ;;
  esac
}

names() {
  local out="" l
  for l in "$@"; do
    if [ -n "$out" ]; then out="$out and "; fi
    out="$out$(display_name "$l")"
  done
  printf '%s' "$out"
}

proc_name() {
  case "$(uname -s):$1" in
    Darwin:ptb) printf 'Discord PTB' ;;
    Darwin:canary) printf 'Discord Canary' ;;
    *:ptb) printf 'DiscordPTB' ;;
    *:canary) printf 'DiscordCanary' ;;
    *) printf 'Discord' ;;
  esac
}

relaunch() {
  local bin
  if [ "$(uname -s)" = Darwin ]; then
    open -a "$(display_name "$1")" 2>/dev/null
    return
  fi
  [ -z "$REAL_USER" ] || return 1
  case "$1" in
    stable) bin=discord ;;
    ptb) bin=discord-ptb ;;
    canary) bin=discord-canary ;;
  esac
  command -v "$bin" >/dev/null 2>&1 || return 1
  nohup "$bin" >/dev/null 2>&1 &
}

say ""
say "  ${C_BOLD}${C_MAGENTA}RestoreGoLive${C_RESET}"
say "  ${C_DIM}P2P screen sharing for Discord${C_RESET}"
say ""

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
      warn "Running as root, using $REAL_USER's home ($HOME)"
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

shim_source() {
  local target
  target=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')
  cat <<SHIM
const target = "$target";
if (require("fs").existsSync(target)) {
  require(target);
} else {
  const path = require("path");
  const message = "[" + new Date().toISOString() + "] [" + process.pid + "] payload missing at " + target + ", starting Discord without it";
  console.error("[RestoreGoLive] " + message);
  try {
    const logs = path.join(path.dirname(target), "..", "logs");
    require("fs").mkdirSync(logs, { recursive: true });
    require("fs").appendFileSync(path.join(logs, "main.log"), message + "\\n");
  } catch {}
  const original = path.join(__dirname, "..", "_app.asar");
  const pkg = require(path.join(original, "package.json"));
  require.main.filename = path.join(original, pkg.main);
  require("electron").app.setAppPath(original);
  require(require.main.filename);
}
SHIM
}

shim_is_ours() {
  grep -qE 'RestoreGoLive|patcher\.js' "$1/index.js" 2>/dev/null
}

legacy_is_ours() {
  grep -q 'RestoreGoLive' "$1/patcher.js" 2>/dev/null || grep -q 'RestoreGoLive' "$1/renderer.js" 2>/dev/null
}

case "$(uname -s)" in
  Darwin)
    DATA="$HOME/Library/Application Support/RestoreGoLive"
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
    DATA="$CONFIG/RestoreGoLive"
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
      fp_data="$fp_cfg/RestoreGoLive"
      CANDIDATES+=(
        "$fp_label|$fp_cfg/${fp_dir//-/}|$fp_data"
        "$fp_label|$HOME/.local/share/flatpak/app/$fp_id/current/active/files/$fp_dir|$fp_data"
        "$fp_label|/var/lib/flatpak/app/$fp_id/current/active/files/$fp_dir|$fp_data"
      )
    done
    ;;
  *) die "Unsupported platform: $(uname -s)" ;;
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

[ "${#FOUND[@]}" -gt 0 ] || die "No Discord installation found. Install Discord and open it once first."

FOUND_LABELS=()
for entry in "${FOUND[@]}"; do FOUND_LABELS+=("${entry%%|*}"); done
DEFAULT=stable
case "$SEEN" in *"[stable]"*) ;; *) DEFAULT="${FOUND_LABELS[0]}" ;; esac

if [ -n "$BRANCH" ]; then
  BRANCH="$(printf '%s' "$BRANCH" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
elif [ "${#FOUND[@]}" -gt 1 ]; then
  ok "Found $(names "${FOUND_LABELS[@]}")"
  OPTS="$(IFS=/; printf '%s' "${FOUND_LABELS[*]}")/all"
  HINT="$(printf '/%s/' "$OPTS" | sed "s|/$DEFAULT/|/$(printf '%s' "$DEFAULT" | tr '[:lower:]' '[:upper:]')/|; s|^/||; s|/$||")"
  while :; do
    BRANCH="$(ask "Which one should RestoreGoLive be installed on?" "$HINT" "$DEFAULT")"
    case "/$OPTS/" in *"/$BRANCH/"*) break ;; esac
  done
else
  BRANCH="$DEFAULT"
fi

TARGETS=()
if [ "$BRANCH" = all ]; then
  TARGETS=("${FOUND[@]}")
else
  for entry in "${FOUND[@]}"; do
    if [ "${entry%%|*}" = "$BRANCH" ]; then TARGETS+=("$entry"); fi
  done
  [ "${#TARGETS[@]}" -gt 0 ] || die "No $BRANCH installation found."
fi

TARGET_LABELS=()
PATCHED_LABELS=()
for entry in "${TARGETS[@]}"; do
  label="${entry%%|*}"
  rest="${entry#*|}"
  TARGET_LABELS+=("$label")
  if [ -d "${rest%%|*}/app.asar" ] && shim_is_ours "${rest%%|*}/app.asar"; then PATCHED_LABELS+=("$label"); fi
done

if [ "${#PATCHED_LABELS[@]}" -gt 0 ]; then
  confirm "RestoreGoLive is already installed on $(names "${PATCHED_LABELS[@]}"). Reinstall?" || { warn "Installation cancelled."; exit 0; }
elif [ "${#FOUND[@]}" -eq 1 ] && [ -z "${P2P_DISCORD_BRANCH:-}" ]; then
  confirm "Install RestoreGoLive on $(names "${TARGET_LABELS[@]}")?" || { warn "Installation cancelled."; exit 0; }
fi

say ""
step "Downloading RestoreGoLive..."
STAGE="$DATA/dist"
mkdir -p "$STAGE"
for f in "${FILES[@]}"; do
  curl -fsSL "$BASE_URL/$f" -o "$STAGE/$f" || die "Could not download $f"
done
fix_owner "$DATA"
ok "Files installed to $STAGE"

for entry in "${TARGETS[@]}"; do
  label="${entry%%|*}"
  rest="${entry#*|}"
  RES="${rest%%|*}"
  TDATA="${rest#*|}"
  [ -n "$TDATA" ] || TDATA="$DATA"

  step "Installing on $(display_name "$label")..."

  if [ "$TDATA" != "$DATA" ]; then
    if ! mkdir -p "$TDATA/dist" 2>/dev/null; then
      fail "Cannot write to $TDATA"
      continue
    fi
    for f in "${FILES[@]}"; do
      cp -f "$STAGE/$f" "$TDATA/dist/$f"
    done
    fix_owner "$TDATA"
    ok "Files copied to $TDATA/dist"
  fi

  if [ -z "$FORCE" ]; then
    if [ -f "$RES/app.asar" ] && [ -f "$RES/_app.asar" ]; then
      warn "Skipped: another mod (likely Vencord) is installed here, rerun with P2P_FORCE=1 to replace it"
      continue
    fi
    if [ -d "$RES/app.asar" ] && ! shim_is_ours "$RES/app.asar"; then
      warn "Skipped: another mod is installed here, rerun with P2P_FORCE=1 to replace it"
      continue
    fi
  fi
  if [ -d "$RES/app.asar" ] && [ -n "$FORCE" ] && ! shim_is_ours "$RES/app.asar"; then
    rm -rf "$RES/app.asar"
  elif [ -f "$RES/app.asar" ] && [ -f "$RES/_app.asar" ]; then
    rm -f "$RES/app.asar"
  fi

  FRESH=0
  if [ -f "$RES/app.asar" ]; then
    rm -f "$RES/_app.asar"
    if ! mv "$RES/app.asar" "$RES/_app.asar" 2>/dev/null; then
      fail "Cannot write to $RES"
      [ "$(uname -s)" = Darwin ] && warn "Grant your terminal App Management in System Settings -> Privacy & Security, then rerun"
      [ "$(uname -s)" = Linux ] && warn "Try again with sudo"
      continue
    fi
    FRESH=1
  fi

  if [ ! -f "$RES/_app.asar" ]; then
    warn "Skipped: no app.asar"
    continue
  fi

  if [ -d "$RES/app" ] && grep -q "patcher.js" "$RES/app/index.js" 2>/dev/null; then
    rm -rf "$RES/app"
  fi

  if ! mkdir -p "$RES/app.asar" 2>/dev/null; then
    fail "Cannot write to $RES"
    continue
  fi
  shim_source "$TDATA/dist/main.js" > "$RES/app.asar/index.js"
  printf '{"name":"discord","main":"index.js","restoreGoLive":true}\n' > "$RES/app.asar/package.json"
  case "$RES" in "$HOME"/*) fix_owner "$RES/app.asar" ;; esac

  if [ "$FRESH" = 1 ]; then
    ok "Installed on $(display_name "$label")"
  else
    ok "Reinstalled on $(display_name "$label")"
  fi

  case "$RES" in
    /var/lib/flatpak/*) warn "A Flatpak update will undo this, just rerun the installer" ;;
  esac
done

LEGACY_IN_USE=0
for entry in "${FOUND[@]}"; do
  rest="${entry#*|}"
  RES="${rest%%|*}"
  grep -q 'patcher\.js' "$RES/app.asar/index.js" 2>/dev/null && LEGACY_IN_USE=1
done
if [ "$LEGACY_IN_USE" = 0 ]; then
  for entry in "${FOUND[@]}"; do
    rest="${entry#*|}"
    TDATA="${rest#*|}"
    [ -n "$TDATA" ] || TDATA="$DATA"
    OLD="${TDATA%/RestoreGoLive}/Vencord/dist"
    legacy_is_ours "$OLD" || continue
    for f in "${LEGACY_FILES[@]}"; do
      rm -f "$OLD/$f" "$OLD/$f.map" "$OLD/$f.LEGAL.txt"
    done
    ok "Removed the old Vencord-based build from $OLD"
  done
fi

if [ "$FAILED" = 1 ]; then
  say ""
  die "Something went wrong, see the messages above."
fi

RUNNING=()
for label in "${TARGET_LABELS[@]}"; do
  if pgrep -x "$(proc_name "$label")" >/dev/null 2>&1; then RUNNING+=("$label"); fi
done

if [ "${#RUNNING[@]}" -gt 0 ]; then
  say ""
  if confirm "$(names "${RUNNING[@]}") is open. Restart it now?"; then
    step "Restarting $(names "${RUNNING[@]}")..."
    for label in "${RUNNING[@]}"; do pkill -x "$(proc_name "$label")" 2>/dev/null || true; done
    sleep 2
    for label in "${RUNNING[@]}"; do
      if relaunch "$label"; then
        ok "Restarted $(display_name "$label")"
      else
        warn "Closed $(display_name "$label"), open it again to load RestoreGoLive."
      fi
    done
  else
    warn "Fully quit $(names "${RUNNING[@]}") and reopen it to load RestoreGoLive."
  fi
fi

say ""
say "  ${C_GREEN}Done!${C_RESET} Discord updates undo the patch on macOS and Linux, just rerun this installer."
say ""
say "  ${C_DIM}To uninstall, run:${C_RESET}"
say "  ${C_CYAN}curl -fsSL https://doce.sh/restore-go-live/uninstall.sh | bash${C_RESET}"
say ""
