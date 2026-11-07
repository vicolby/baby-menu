# Contributing

Thanks for wanting to contribute.
One rule up front:

**Human-authored pull requests targeting `main` must be raised through [`no-mistakes`](https://github.com/kunchenguid/no-mistakes).**
We require this to reduce the maintainer's burden of reviewing and merging contributions.

`no-mistakes` puts a local git proxy in front of your real remote.
Pushing through it runs an AI-driven review, test, lint, and CI pipeline in an isolated worktree, forwards the push upstream only after every check passes, and opens a clean PR automatically.

A GitHub Actions check named `PR must be raised via no-mistakes` runs on PRs targeting `main` and fails if the body is missing the deterministic signature that no-mistakes writes, or if the structured pipeline attestation does not show `review`, `test`, and `document` as completed.
Known automation accounts are exempt so dependency and release automation can keep working.
Regular contributor PRs without the signature and attestation will not be reviewed or merged.

## Workflow

Fork routing requires `no-mistakes` v1.30.1 or newer.
This repository's required check also needs `no-mistakes` >= 1.46.0 so the PR body includes structured pipeline step attestation.

1. Fork the repo, then clone the parent repo or set your local `origin` back to the parent repo (`git@github.com:vicolby/baby-menu.git`).
2. Create a branch and make your changes.
3. Initialize or refresh the gate with your fork as the push target: `no-mistakes init --fork-url git@github.com:<you>/baby-menu.git`.
4. Commit your changes.
5. Push through the gate instead of pushing to `origin`: `git push no-mistakes`.
6. Run `no-mistakes` to attach to the pipeline, watch findings, and auto-fix or review as needed.
7. Once the pipeline passes, it pushes the branch to your fork and opens the PR against this repo for you.

See the [no-mistakes quick start](https://kunchenguid.github.io/no-mistakes/start-here/quick-start/) for the full first-run walkthrough.

## Repo Conventions

- Use `pnpm` with the pinned version from `packageManager`.
- Tests live in `tests/` at the repo root.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before pushing.
- Run `pnpm generate:contracts` and commit `extensions/babymenu-env.d.ts` after changing extension-facing types or `src/shared/extension-contract-names.ts`.
- Run `pnpm package:mac` when changing packaging, runtime paths, extension compilation, native dependencies, or release behavior.
- Local `pnpm package:mac` builds intentionally produce `Baby Menu Dev.app` with bundle id `com.vicolby.baby-menu.dev`; release automation uses `electron-builder.yml` directly for the production `Baby Menu.app` identity.
- Follow the universal native-dependency, build-only esbuild exclusion, and packaged runtime verification constraints in [`docs/development.md`](docs/development.md#packaging).
- Keep `pnpm-lock.yaml` changes with dependency changes.
- Do not commit generated build output, release artifacts, runtime caches, or dev extension workspaces.
- Do not hand-edit release-please metadata such as `CHANGELOG.md` or `.release-please-manifest.json`.
- See `AGENTS.md` for architecture notes, extension workspace rules, and agent-specific constraints.

## Release Notes

Baby Menu releases are proposed by release-please after conventional commits land on `main`.
Use prefixes such as `feat:` and `fix:` so release-please can choose the version bump and release notes.
Mark breaking changes with `!` in the commit type or a `BREAKING CHANGE:` footer.
Merging the release-please PR creates the version tag and a draft GitHub Release.
The release-please workflow builds the universal macOS app, ad-hoc signs every code object with `scripts/adhoc-sign-mac-app.mjs` (there is no Apple Developer ID, so releases are not notarized), verifies the publication-ready DMG, runs the packaged runtime E2E, computes its checksum, uploads it to the draft, and only then publishes the release before updating `vicolby/homebrew-tap`.
Any build, signing, verification, packaged runtime, checksum, or GitHub upload failure leaves the release as a draft and stops before stable publication and tap publication. A missing or invalid `HOMEBREW_TAP_TOKEN`, or another tap update failure, occurs after stable publication and fails the workflow without updating Homebrew.
The generated Homebrew Cask clears the quarantine attribute after install so Gatekeeper launches the non-notarized app, quits Baby Menu during upgrade, and relaunches it after installation only when the app was already running before uninstall started.

Repository configuration:

- Secret `HOMEBREW_TAP_TOKEN` - a fine-grained token with Contents read and write access to `vicolby/homebrew-tap`, used for the final cask update.
- Optional variables `BABY_MENU_UMAMI_HOST` and `BABY_MENU_UMAMI_WEBSITE_ID` - enable packaged-release telemetry only when both are set. They are variables rather than secrets because both are baked into the app.
- Settings > Actions > General must allow workflows read and write permissions and allow GitHub Actions to create pull requests, so release-please can open its release PR.

Never commit or print credential contents. Pull-request CI remains secret-free and validates the release config through `tests/release-config.test.ts`.

To release, merge the release-please PR and require the `release-please` workflow's macOS job to pass. The release remains a draft until the artifact passes verification and runtime E2E, receives a valid checksum, and uploads successfully. If the macOS job fails, fix the cause and re-run the failed job; do not upload a replacement DMG or update the tap by hand.
For a post-release check of exactly the downloaded artifact on macOS:

```sh
VERSION=x.y.z # Replace with the released version.
TAG="baby-menu-v${VERSION}"
mkdir -p verify-baby-menu/mount

gh release download "$TAG" --pattern "Baby-Menu-${VERSION}-universal.dmg" --dir verify-baby-menu
DMG="$PWD/verify-baby-menu/Baby-Menu-${VERSION}-universal.dmg"
hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$PWD/verify-baby-menu/mount"
trap 'hdiutil detach "$PWD/verify-baby-menu/mount" >/dev/null' EXIT
APP="$PWD/verify-baby-menu/mount/Baby Menu.app"

test "$(plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")" = \
  "com.vicolby.baby-menu"
test "$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist")" = \
  "$VERSION"
codesign --verify --deep --strict --verbose=4 "$APP"
SIGNATURE="$(codesign -d --verbose=4 "$APP" 2>&1)"
grep -Fq 'Identifier=com.vicolby.baby-menu' <<<"$SIGNATURE"
grep -Fq 'Signature=adhoc' <<<"$SIGNATURE"
test "$(lipo -archs "$APP/Contents/MacOS/Baby Menu" | tr ' ' '\n' | LC_ALL=C sort | xargs)" = "arm64 x86_64"

hdiutil detach "$PWD/verify-baby-menu/mount"
trap - EXIT
```

The workflow runs these checks, plus per-bundle and per-Mach-O ad-hoc signature and architecture checks, against the mounted publication-ready DMG before upload.

## Questions

Open an issue if something is unclear.
