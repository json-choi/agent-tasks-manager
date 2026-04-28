# Releasing

ATM uses Release Please and GitHub Actions for CI, version bumps, changelog generation, GitHub Releases, and npm publishing.

## Required GitHub Settings

- Enable Actions for the repository.
- Allow GitHub Actions to create pull requests if using the default `GITHUB_TOKEN`.
- Optional: add a `RELEASE_PLEASE_TOKEN` secret with a personal access token if release PRs should trigger normal CI workflows.

## Required npm Settings

Preferred setup: configure npm Trusted Publishing for this package.

- Package: `agent-tasks-manager`
- Publisher: GitHub Actions
- GitHub owner: `json-choi`
- GitHub repository: `agent-tasks-manager`
- Workflow filename: `release.yml`
- Environment name: leave blank unless the workflow is changed to use a deployment environment

Fallback setup: add a repository secret named `NPM_TOKEN` containing an npm automation/granular token that can publish this package and bypass publish-time 2FA.

## Versioning

Use Conventional Commit messages on commits merged into `main`.

```text
fix: correct Slack digest cursor handling      -> patch release
feat: add Linear adapter                       -> minor release
feat!: change agent plugin API payload shape   -> major release
```

Release Please opens or updates a release PR after releasable commits reach `main`. The PR updates:

- `package.json`
- `CHANGELOG.md`
- `.release-please-manifest.json`

Merging that release PR creates a GitHub Release and publishes the package to npm.

## Manual Checks

The release workflow runs the same checks as CI before publishing:

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
bun run cli:check
npm pack --dry-run
```
