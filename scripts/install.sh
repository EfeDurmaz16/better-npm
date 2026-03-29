#!/bin/sh
# better — install script
# Usage: curl -fsSL https://better.sh/install | sh
#        curl -fsSL https://raw.githubusercontent.com/EfeDurmaz16/better-npm/main/scripts/install.sh | sh
#
# Environment variables:
#   BETTER_HOME    — install directory (default: ~/.better)
#   BETTER_VERSION — specific version to install (default: latest)

set -eu

# ─── Colors ───────────────────────────────────────────────────────────────────

setup_colors() {
  if [ -t 1 ] && [ -t 2 ]; then
    BOLD="$(tput bold 2>/dev/null || printf '')"
    DIM="$(tput dim 2>/dev/null || printf '')"
    RED="$(tput setaf 1 2>/dev/null || printf '')"
    GREEN="$(tput setaf 2 2>/dev/null || printf '')"
    YELLOW="$(tput setaf 3 2>/dev/null || printf '')"
    CYAN="$(tput setaf 6 2>/dev/null || printf '')"
    RESET="$(tput sgr0 2>/dev/null || printf '')"
  else
    BOLD="" DIM="" RED="" GREEN="" YELLOW="" CYAN="" RESET=""
  fi
}

info()    { printf "${CYAN}${BOLD}info${RESET}  %s\n" "$@"; }
success() { printf "${GREEN}${BOLD}  ok${RESET}  %s\n" "$@"; }
warn()    { printf "${YELLOW}${BOLD}warn${RESET}  %s\n" "$@" >&2; }
error()   { printf "${RED}${BOLD} err${RESET}  %s\n" "$@" >&2; exit 1; }

# ─── Dependency checks ───────────────────────────────────────────────────────

has() { command -v "$1" >/dev/null 2>&1; }

check_deps() {
  if ! has curl && ! has wget; then
    error "curl or wget is required to download better"
  fi
  if ! has tar; then
    error "tar is required to extract better"
  fi
}

# ─── Platform detection ──────────────────────────────────────────────────────

detect_platform() {
  platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$platform" in
    linux)                  platform="unknown-linux-gnu" ;;
    darwin)                 platform="apple-darwin" ;;
    msys_nt*|cygwin_nt*|mingw*)
      error "Windows detected — use PowerShell instead:
  irm https://better.sh/install.ps1 | iex"
      ;;
    freebsd)                platform="unknown-freebsd" ;;
    *)                      error "Unsupported platform: $platform" ;;
  esac

  # musl detection (Alpine, Void, etc.)
  if [ "$platform" = "unknown-linux-gnu" ]; then
    if [ -f /etc/alpine-release ] || (has ldd && ldd --version 2>&1 | grep -qi musl); then
      platform="unknown-linux-musl"
    fi
  fi

  printf '%s' "$platform"
}

detect_arch() {
  arch="$(uname -m | tr '[:upper:]' '[:lower:]')"
  case "$arch" in
    x86_64|amd64)   arch="x86_64" ;;
    aarch64|arm64)   arch="aarch64" ;;
    armv7*)          arch="armv7" ;;
    *)               error "Unsupported architecture: $arch" ;;
  esac

  # Rosetta 2 detection — prefer native arm64 on Apple Silicon
  if [ "$arch" = "x86_64" ]; then
    if [ "$(uname -s)" = "Darwin" ]; then
      if sysctl -n sysctl.proc_translated 2>/dev/null | grep -q 1; then
        arch="aarch64"
        warn "Rosetta 2 detected — installing native arm64 binary"
      fi
    fi
  fi

  printf '%s' "$arch"
}

# ─── Download helper ─────────────────────────────────────────────────────────

download() {
  url="$1"
  output="$2"
  if has curl; then
    curl --fail --location --progress-bar --output "$output" "$url"
  elif has wget; then
    wget --quiet --show-progress --output-document="$output" "$url"
  fi
}

# ─── Shell profile detection ─────────────────────────────────────────────────

detect_shell_profile() {
  shell_name="$(basename "${SHELL:-/bin/sh}")"
  case "$shell_name" in
    zsh)
      echo "${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    bash)
      # Prefer .bash_profile on macOS, .bashrc on Linux
      if [ -f "$HOME/.bash_profile" ]; then
        echo "$HOME/.bash_profile"
      elif [ -f "$HOME/.bashrc" ]; then
        echo "$HOME/.bashrc"
      else
        echo "$HOME/.bash_profile"
      fi
      ;;
    fish)
      echo "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
      ;;
    *)
      echo "$HOME/.profile"
      ;;
  esac
}

update_shell_profile() {
  profile="$1"
  bin_dir="$2"

  if [ ! -f "$profile" ]; then
    : > "$profile"
  fi

  # Don't add if already present
  if grep -q "BETTER_HOME" "$profile" 2>/dev/null; then
    return 0
  fi

  shell_name="$(basename "${SHELL:-/bin/sh}")"
  case "$shell_name" in
    fish)
      cat >> "$profile" << EOF

# better
set -gx BETTER_HOME "$BETTER_HOME"
set -gx PATH "\$BETTER_HOME/bin" \$PATH
EOF
      ;;
    *)
      cat >> "$profile" << EOF

# better
export BETTER_HOME="$BETTER_HOME"
export PATH="\$BETTER_HOME/bin:\$PATH"
EOF
      ;;
  esac
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  setup_colors
  check_deps

  BETTER_HOME="${BETTER_HOME:-$HOME/.better}"
  BETTER_VERSION="${BETTER_VERSION:-latest}"
  GITHUB_REPO="EfeDurmaz16/better-npm"

  platform="$(detect_platform)"
  arch="$(detect_arch)"
  target="${arch}-${platform}"

  info "Detected platform: ${BOLD}${target}${RESET}"

  # Construct download URL
  if [ "$BETTER_VERSION" = "latest" ]; then
    url="https://github.com/${GITHUB_REPO}/releases/latest/download/better-${target}.tar.gz"
  else
    url="https://github.com/${GITHUB_REPO}/releases/download/v${BETTER_VERSION}/better-${target}.tar.gz"
  fi

  # Create install directory
  bin_dir="${BETTER_HOME}/bin"
  mkdir -p "$bin_dir"

  # Download to temp
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  info "Downloading better..."
  download "$url" "$tmp_dir/better.tar.gz" || error "Download failed — check if a release exists for ${target}
  ${DIM}${url}${RESET}"

  # Extract
  info "Extracting..."
  tar -xzf "$tmp_dir/better.tar.gz" -C "$tmp_dir" || error "Extraction failed"

  # Install binary
  if [ -f "$tmp_dir/better-core" ]; then
    mv "$tmp_dir/better-core" "$bin_dir/better"
  elif [ -f "$tmp_dir/better" ]; then
    mv "$tmp_dir/better" "$bin_dir/better"
  else
    # Handle nested directory from tar
    found="$(find "$tmp_dir" -name 'better-core' -o -name 'better' | head -1)"
    if [ -n "$found" ]; then
      mv "$found" "$bin_dir/better"
    else
      error "Could not find better binary in archive"
    fi
  fi

  chmod +x "$bin_dir/better"

  # Update PATH in shell profile
  profile="$(detect_shell_profile)"
  update_shell_profile "$profile" "$bin_dir"

  # Verify
  if "$bin_dir/better" --version >/dev/null 2>&1; then
    version="$("$bin_dir/better" --version 2>/dev/null || echo "installed")"
  else
    version="installed"
  fi

  echo ""
  success "${BOLD}better${RESET} ${GREEN}${version}${RESET} installed to ${CYAN}${bin_dir}/better${RESET}"
  echo ""

  # Check if already in PATH
  case ":$PATH:" in
    *":${bin_dir}:"*) ;;
    *)
      info "Added ${CYAN}${bin_dir}${RESET} to ${DIM}${profile}${RESET}"
      echo ""
      warn "Restart your shell or run:"
      echo ""
      echo "  ${BOLD}source ${profile}${RESET}"
      echo ""
      ;;
  esac

  echo "  ${DIM}Get started:${RESET}"
  echo "    ${BOLD}better install${RESET}      Install dependencies"
  echo "    ${BOLD}better doctor${RESET}       Health check your project"
  echo "    ${BOLD}better --help${RESET}       See all commands"
  echo ""
}

main "$@"
