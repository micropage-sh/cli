#!/usr/bin/env node
'use strict';

/**
 * Updates the Homebrew tap formula with new version and SHA256 checksums.
 *
 * Usage:
 *   RELEASE_VERSION=2.1.0 \
 *   SHA_DARWIN_ARM64=abc123... \
 *   SHA_DARWIN_AMD64=def456... \
 *   SHA_LINUX_AMD64=ghi789... \
 *   node scripts/update-tap-formula.js <path-to-formula.rb>
 *
 * Called by the release GitHub Actions workflow after computing checksums.
 */

const fs = require('fs');

const version = process.env.RELEASE_VERSION;
const sha_darwin_arm64 = process.env.SHA_DARWIN_ARM64;
const sha_darwin_amd64 = process.env.SHA_DARWIN_AMD64;
const sha_linux_amd64 = process.env.SHA_LINUX_AMD64;
const formulaPath = process.argv[2];

if (!version || !sha_darwin_arm64 || !sha_darwin_amd64 || !sha_linux_amd64) {
  console.error(
    'Missing required env vars: RELEASE_VERSION, SHA_DARWIN_ARM64, SHA_DARWIN_AMD64, SHA_LINUX_AMD64'
  );
  process.exit(1);
}

if (!formulaPath) {
  console.error('Usage: node scripts/update-tap-formula.js <path-to-formula.rb>');
  process.exit(1);
}

const BASE_URL = `https://github.com/micropage-sh/cli/releases/download/v${version}`;

const formula = `class Micropage < Formula
  desc "CLI for micropage.sh - create, sync, and publish microsites"
  homepage "https://github.com/micropage-sh/cli"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "${BASE_URL}/micropage-darwin-arm64.tar.gz"
      sha256 "${sha_darwin_arm64}"
    else
      url "${BASE_URL}/micropage-darwin-amd64.tar.gz"
      sha256 "${sha_darwin_amd64}"
    end
  end

  on_linux do
    url "${BASE_URL}/micropage-linux-amd64.tar.gz"
    sha256 "${sha_linux_amd64}"
  end

  def install
    bin.install "micropage"
  end

  test do
    assert_match version.to_s, shell_output("\#{bin}/micropage --version")
  end
end
`;

fs.writeFileSync(formulaPath, formula, 'utf8');
console.log(`Updated ${formulaPath} to v${version}`);
