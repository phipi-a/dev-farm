# Release and upgrade policy

This repository ships three TypeScript package archives and a developer base
image. The release workflows validate and record these artifacts; they do not
publish to npm because all three package manifests are currently private.
The GitHub Release is the distribution point until a separately approved npm
publisher and package visibility change exist.

## Release contract

A release is one immutable source commit and one semantic version `X.Y.Z`:

- The annotated or lightweight tag is `vX.Y.Z`.
- `CHANGELOG.md` has a reviewed `## X.Y.Z` section in that tagged commit.
- The root package and `packages/{core,pi-extension,cli}/package.json` versions
  are all `X.Y.Z`. The release workflow fails before producing artifacts if
  they differ; `0.0.0` is a development placeholder, not a releasable version.
- The Core, Pi extension, and CLI archives are built once from that commit.
- The image is tagged with `X.Y.Z`, and its OCI labels include the image,
  Pi, and GitHub CLI versions. Consumers use the digest in
  `release-record.json`, never a floating tag.

Only `v` tags with three numeric semver components start the release workflow.
A release PR should update the package versions and changelog together. Do not
manually edit generated archives or move an existing tag. A corrected build
uses a new patch version. Pre-release tags are not currently published by the
workflow and require an explicit workflow change.

### What CI checks

`.github/workflows/ci.yml` runs for pull requests and pushes to `main`:

1. `npm ci --ignore-scripts` uses the lockfile without executing dependency
   install scripts.
2. `npm audit --audit-level=high` blocks known high and critical dependency
   vulnerabilities before validation.
3. `npm run ci` runs formatting, lint, type checking, and tests.
4. All three workspaces are built and packed. The archives and SHA-256 list are
   retained as a short-lived CI artifact.
5. `docker/base-image/smoke.sh` builds the image without credentials and checks
   the non-root user, writable workspace, pinned tools, and Pi health command.
   Trivy blocks high and critical fixed vulnerabilities in the resulting image.

`.github/workflows/release.yml` repeats package validation and the dependency
audit, requires exact version alignment, runs the image smoke and vulnerability
checks, pushes only the versioned image to GHCR, and creates or updates a GitHub
Release. Package archives receive GitHub artifact attestations, and the image
build publishes OCI provenance and an SBOM alongside the image. A release is not
considered complete until the release job has attached:

- the three `.tgz` archives and `SHA256SUMS`;
- `image-record.json`, containing the image reference, immutable digest, source
  commit, image version, Pi version, and GitHub CLI version;
- `release-record.json`, joining the tag, source commit, package hashes, and
  image record; and
- the checked-in `CHANGELOG.md`.

The image job uses the repository's `GITHUB_TOKEN` only for GHCR package write
access. It logs in through stdin and never writes the token to an artifact.
Package publishing does not use an npm token. A failed package/version check,
smoke check, or image push blocks the release record and is visible as a
failed required workflow job.

## Compatibility matrix

All artifacts in one release have the same release version and source commit.
The following is the supported compatibility rule until a formal API matrix is
added:

| Consumer               | Compatible artifact               | Rule                                                                                                                                            |
| ---------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Core consumers         | `@agent-farm/core`                | Same major version; minor and patch upgrades are expected to be backward compatible.                                                            |
| Pi extension           | `@agent-farm/pi-extension` + Core | Use the same release version and commit. Do not mix major versions; test an extension against the exact Core archive it loads.                  |
| CLI                    | `@agent-farm/cli` + Core          | Use the same release version and commit. A CLI/Core major mismatch is unsupported.                                                              |
| Worker tooling         | `dev-farm/pi-agent-base:X.Y.Z`    | Pin the recorded digest. The image provides Pi, Git, GitHub CLI, tmux, ripgrep, and curl; it does not currently bundle the TypeScript packages. |
| Pi/GitHub CLI in image | OCI labels in `image-record.json` | These tool versions are independently pinned inputs. Their change is an image rebuild and smoke check, not a Core API change.                   |

The current manifests do not declare runtime dependencies between Core, the
extension, and CLI. The same-version rule is therefore an operational
compatibility guard, not a substitute for a future tested API matrix. A
consumer must verify the release record and archive hashes before installation.

## Upgrade and migration

There is no persistent runtime schema or automated migration in the current
repository. An upgrade is therefore an artifact replacement, not an in-place
state migration:

1. Record the current package versions, image digest, worker configuration,
   and any active workspace/state identifiers.
2. Drain active workers at a safe boundary; do not replace an image while a
   worker is writing its workspace.
3. Validate the new package hashes and image digest from the GitHub Release.
4. Run the package checks and image smoke command in a staging environment.
5. Start new workers with the new package set/image digest and retain the old
   digest until every worker has been verified.
6. Record the release version and digest alongside each worker/run record.

If a future release introduces a state schema, its changelog section must
include a numbered, idempotent migration, preflight checks, backup/restore
procedure, and whether downgrade is supported. Never infer a migration from a
package version alone.

## Rollback

Rollback is to the last known-good release record, not to `latest`:

1. Stop admission of new work and capture failing run IDs and logs with secrets
   redacted.
2. Repoint new workers to the previous package archives and image digest.
3. Allow in-flight work to finish only when the old and new contracts are
   explicitly compatible; otherwise stop and restore from the recorded
   workspace/state backup.
4. Verify the previous image digest and package SHA-256 values, then run the
   smoke checks before reopening admission.
5. Keep the failed release tag and GitHub workflow evidence. Do not delete or
   move it; publish a new patch release containing the fix.

Because no migration exists today, a package/image rollback must not be used
to pretend that a future destructive state migration was reversed. Such a
migration needs its own tested forward and rollback plan before release.

## Smoke checks and failure visibility

The image smoke script is intentionally credential-free. It verifies a
non-root `dev` user, `/workspace/project` write access, `HOME` and `WORKSPACE`,
and the `pi`, `git`, `gh`, `tmux`, `rg`, and `curl` commands. The Docker
healthcheck repeats the essential tool checks at runtime.

CI failures remain visible as named `packages`, `base-image-smoke`,
`build-release-packages`, `release-image-smoke`, `publish-base-image`, and
`record-release` jobs. Logs may contain compiler output and hashes, but must
not contain token values, authenticated URLs, environment dumps, or private
source. If an image push succeeds while `record-release` fails, use the image
reference and commit shown in the job output to reconcile the digest, then
rerun the tagged workflow; never publish a second mutable tag.

## Secret and artifact rules

- Use the GitHub-provided token only through the workflow permission needed for
  the operation. Do not add an npm token until package publication is approved.
- Authenticate Docker with `--password-stdin`; never put a credential in a
  command argument, Dockerfile, build argument, package archive, changelog, or
  release record.
- Review archive contents and generated records before extending this workflow
  to publish. Archives must contain built package output and package metadata,
  not `.env` files, credentials, or runner state.
- Treat GitHub Actions logs and retained artifacts as potentially readable by
  repository collaborators. Keep retention bounded and rotate a credential if
  exposure is suspected.
- Third-party GitHub Actions are referenced by reviewed commit SHA (with a
  version comment); update a SHA only as part of a dependency review.

## Integration assumptions and gaps

- `main` is the protected default branch and GitHub Releases/GHCR are enabled.
- The repository owner permits `GITHUB_TOKEN` package writes and the GHCR image
  name is `ghcr.io/<owner>/dev-farm/pi-agent-base`.
- Branch protection must require the CI jobs before a release tag can be
  created. Tag creation itself remains a human-authorized action.
- npm audit and the pinned Trivy action require network access to their
  vulnerability databases in GitHub Actions; normal local tests remain
  credential-free. GitHub artifact attestations require the repository's
  artifact-attestation feature, and OCI provenance/SBOM publication requires
  GHCR support. No signing key or persistent worker-state store is configured
  here.
- The current image smoke check requires a Docker-compatible runner and network
  access to the pinned Debian, npm, Pi, and GitHub CLI inputs; it does not need
  project credentials.
