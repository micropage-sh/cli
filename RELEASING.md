# Release Guide

This document covers how to test binaries locally, do a dry run, and cut a production release.

## Prerequisites

- Node.js ≥ 18 installed locally
- `@yao-pkg/pkg` available via `npm ci` (already in devDependencies)
- A GitHub Personal Access Token (PAT) with `contents: write` on `micropage-sh/homebrew-tap`
  stored as the `TAP_GITHUB_TOKEN` secret in the CLI repo settings

---

## Local binary test (before first release)

```bash
cd cli/

# Install deps including devDependencies
npm ci

# Build all three platform binaries into dist/
npm run build:linux
npm run build:macos-amd64
npm run build:macos-arm64

# Test the binary for your current platform (Linux)
./dist/micropage-linux-amd64 --help
./dist/micropage-linux-amd64 --version

# Try a real command (needs internet + auth)
./dist/micropage-linux-amd64 whoami
```

On macOS, run the `micropage-darwin-*` binary instead. Verify that:
- `--help` and `--version` work
- `login` opens the browser correctly
- `projects list` (while logged in) returns the same output as the npm version

---

## Test the update script locally

```bash
RELEASE_VERSION=2.0.0 \
SHA_DARWIN_ARM64=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
SHA_DARWIN_AMD64=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
SHA_LINUX_AMD64=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  node scripts/update-tap-formula.js ../homebrew-tap/Formula/micropage.rb

# Inspect the result
cat ../homebrew-tap/Formula/micropage.rb
```

---

## Pre-release checklist

- [ ] `package.json` version matches the tag you're about to push
- [ ] No secrets or local `.env` files checked in
- [ ] `TAP_GITHUB_TOKEN` secret is set in the CLI repo's GitHub Actions settings
- [ ] `homebrew-tap` repo exists on GitHub (even as private) so the push step doesn't fail
- [ ] Run `./dist/micropage-linux-amd64 --help` locally to verify the binary is clean

---

## Cutting a release

1. Bump the version in `package.json` and commit.
2. Tag and push:

```bash
git tag v2.0.0
git push origin v2.0.0
```

3. GitHub Actions runs the `release.yml` workflow automatically:
   - Builds `micropage-linux-amd64`, `micropage-darwin-amd64`, `micropage-darwin-arm64` binaries
   - Packages each as a `.tar.gz` containing a single `micropage` executable
   - Computes SHA256 checksums
   - Creates a GitHub Release and uploads the three tarballs
   - Checks out the tap repo and updates `Formula/micropage.rb` with the new version and hashes
   - Commits and pushes the updated formula to `micropage-sh/homebrew-tap`

4. Verify the release on GitHub: confirm the three `.tar.gz` assets are attached.
5. Verify the tap formula was updated: check `micropage-sh/homebrew-tap/Formula/micropage.rb`.

---

## Making repos public at launch

When you're ready for public availability:

1. Make `micropage-sh/cli` public on GitHub.
2. Make `micropage-sh/homebrew-tap` public on GitHub.
3. Update `README.md` in the CLI repo to include the brew install instructions.
4. Users can now install with:

```bash
brew tap micropage-sh/tap
brew install micropage
```

---

## Publishing to npm (dual distribution)

The binary release and npm release are independent. To publish to npm:

```bash
npm publish --access public
```

Both install paths (`brew install` and `npm install -g micropage`) produce the same CLI behaviour.
