#!/bin/sh
set -eu

REPOSITORY="timescale/searchgres"
BINARIES="searchgres searchgres-server searchgres-mcp"
MAX_RETRIES=3
TEMP_DIR=""

if [ -t 1 ]; then
  BOLD='\033[1m'
  GREEN='\033[32m'
  RED='\033[31m'
  YELLOW='\033[33m'
  CYAN='\033[36m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' RED='' YELLOW='' CYAN='' RESET=''
fi

main() {
  check_dependencies

  os="$(detect_os)"
  arch="$(detect_arch)"
  extension=""
  if [ "$os" = "windows" ]; then
    extension=".exe"
  fi

  if [ -n "${SEARCHGRES_VERSION:-}" ]; then
    version="$SEARCHGRES_VERSION"
  else
    version="$(fetch_latest_version)"
  fi
  case "$version" in
    ''|*[!A-Za-z0-9._-]*) err "Invalid release version: ${version}" ;;
  esac

  install_dir="$(resolve_install_dir)"
  release_base="${SEARCHGRES_RELEASE_BASE_URL:-https://github.com/${REPOSITORY}/releases/download}"
  release_url="${release_base%/}/${version}"

  TEMP_DIR="$(mktemp -d)"
  trap cleanup 0
  trap 'exit 1' HUP INT TERM

  info "Installing ${BOLD}Searchgres ${version}${RESET} (${os}/${arch})"

  for binary in $BINARIES; do
    asset="${binary}-${os}-${arch}${extension}"
    staged="${TEMP_DIR}/${asset}"
    checksum="${TEMP_DIR}/${asset}.sha256"
    binary_url="${release_url}/${asset}"

    info "Downloading ${CYAN}${binary_url}${RESET}"
    download_with_retry "$binary_url" "$staged"
    download_with_retry "${binary_url}.sha256" "$checksum"
    verify_checksum "$staged" "$checksum"
    chmod +x "$staged"
  done

  if [ "$os" = "macos" ]; then
    prepare_macos_binaries "$arch" "$extension"
  fi

  mkdir -p "$install_dir"
  for binary in $BINARIES; do
    asset="${binary}-${os}-${arch}${extension}"
    destination="${install_dir}/${binary}${extension}"
    mv -f "${TEMP_DIR}/${asset}" "$destination"
    success "Installed ${BOLD}${destination}${RESET}"
  done

  case ":${PATH}:" in
    *":${install_dir}:"*) ;;
    *)
      warn "Add ${BOLD}${install_dir}${RESET} to your PATH:"
      printf '    export PATH="%s:$PATH"\n\n' "$install_dir"
      ;;
  esac

  printf "  Run '${BOLD}searchgres --help${RESET}' to get started.\n\n"
}

check_dependencies() {
  command -v curl >/dev/null 2>&1 || err "curl is required"
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    err "sha256sum or shasum is required for checksum verification"
  fi
}

detect_os() {
  case "$(uname -s)" in
    Linux*) echo "linux" ;;
    Darwin*) echo "macos" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) err "Unsupported OS: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) err "Unsupported architecture: $(uname -m)" ;;
  esac
}

resolve_install_dir() {
  if [ -n "${SEARCHGRES_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$SEARCHGRES_INSTALL_DIR"
  elif [ -d "$HOME/.local/bin" ] || [ -d "$HOME/.local" ]; then
    printf '%s\n' "$HOME/.local/bin"
  else
    printf '%s\n' "$HOME/bin"
  fi
}

fetch_latest_version() {
  url="$(curl -sSfL -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPOSITORY}/releases/latest")"
  case "$url" in
    */releases/tag/*) ;;
    *) err "Failed to determine latest release from: ${url}" ;;
  esac
  version="${url##*/}"
  [ -n "$version" ] || err "Failed to determine latest release version"
  printf '%s\n' "$version"
}

download_with_retry() {
  url="$1"
  output="$2"
  attempt=1
  while [ "$attempt" -le "$MAX_RETRIES" ]; do
    if curl -sSfL "$url" -o "$output"; then
      return 0
    fi
    if [ "$attempt" -lt "$MAX_RETRIES" ]; then
      delay=$((attempt * attempt))
      warn "Download failed (attempt ${attempt}/${MAX_RETRIES}); retrying in ${delay}s"
      sleep "$delay"
    fi
    attempt=$((attempt + 1))
  done
  err "Download failed after ${MAX_RETRIES} attempts: ${url}"
}

verify_checksum() {
  file="$1"
  checksum_file="$2"
  expected="$(awk 'NR == 1 { print $1 }' "$checksum_file")"
  case "$expected" in
    *[!0-9A-Fa-f]*|'') err "Invalid checksum file for $(basename "$file")" ;;
  esac
  [ "${#expected}" -eq 64 ] || err "Invalid checksum file for $(basename "$file")"

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{ print $1 }')"
  else
    actual="$(shasum -a 256 "$file" | awk '{ print $1 }')"
  fi
  if [ "$expected" != "$actual" ]; then
    err "Checksum mismatch for $(basename "$file")\n  Expected: ${expected}\n  Actual:   ${actual}"
  fi
  success "Checksum verified: $(basename "$file")"
}

prepare_macos_binaries() {
  arch="$1"
  extension="$2"
  entitlements="${TEMP_DIR}/searchgres-entitlements.plist"
  cat > "$entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-executable-page-protection</key>
  <true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
PLIST

  for binary in $BINARIES; do
    staged="${TEMP_DIR}/${binary}-macos-${arch}${extension}"
    codesign --remove-signature "$staged" 2>/dev/null || true
    codesign --entitlements "$entitlements" -f --deep -s - "$staged" 2>/dev/null || true
    xattr -d com.apple.quarantine "$staged" 2>/dev/null || true
  done
}

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR" || true
  fi
}

info() { printf "${CYAN}=>${RESET} %b\n" "$*"; }
success() { printf "${GREEN}=>${RESET} %b\n" "$*"; }
warn() { printf "${YELLOW}=>${RESET} %b\n" "$*" >&2; }
err() { printf "${RED}error:${RESET} %b\n" "$*" >&2; exit 1; }

main
