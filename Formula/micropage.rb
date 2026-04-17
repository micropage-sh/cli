# Homebrew formula for micropage CLI (prebuilt binary distribution)
# This file lives in the CLI repo as the canonical source.
# The automated release workflow copies updated versions to the tap repo
# at micropage-sh/homebrew-tap.
#
# Install via tap:
#   brew tap micropage-sh/tap
#   brew install micropage

class Micropage < Formula
  desc "CLI for micropage.sh - create, sync, and publish microsites"
  homepage "https://github.com/micropage-sh/cli"
  version "2.0.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/micropage-sh/cli/releases/download/v2.0.0/micropage-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER_DARWIN_ARM64"
    else
      url "https://github.com/micropage-sh/cli/releases/download/v2.0.0/micropage-darwin-amd64.tar.gz"
      sha256 "PLACEHOLDER_DARWIN_AMD64"
    end
  end

  on_linux do
    url "https://github.com/micropage-sh/cli/releases/download/v2.0.0/micropage-linux-amd64.tar.gz"
    sha256 "PLACEHOLDER_LINUX_AMD64"
  end

  def install
    bin.install "micropage"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/micropage --version")
  end
end
