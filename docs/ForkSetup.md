# Fork setup

The public fork is [PeytonWDYM/OpenFront_Agents](https://github.com/PeytonWDYM/OpenFront_Agents).
Its upstream repository is [openfrontio/OpenFrontIO](https://github.com/openfrontio/OpenFrontIO).

The initial fork includes all 405 upstream branches and 300 tags, with full Git history.
GitHub issues, pull requests, release descriptions, and private services are not part of the Git checkout.
The closed-source API is not available in the upstream repository.

## Local Git settings

- `origin`: the public fork, used for pushes and branch tracking.
- `upstream`: the original repository, used to fetch updates.
- Default GitHub CLI repository: `PeytonWDYM/OpenFront_Agents`.
- Default push remote: `origin`, with `push.default=simple`.
- Pulls require a fast-forward. Fetches prune deleted remote branches.
- Checkout preserves LF line endings through `.gitattributes` and local `core.autocrlf=false`.
- Commits use the existing Git identity. No global Git settings were changed.

For a new feature:

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/your-change
```

To inspect upstream updates:

```bash
git fetch upstream --tags
git log --oneline main..upstream/main
```

Integrate upstream changes on a separate branch and review them before merging.

## Runtime and commit hooks

The project requires Node.js 24.15 or newer within Node 24, and npm 12.1 or newer within npm 12.
Use the versions required by `package.json` if those requirements change.
After selecting compatible versions, install dependencies and activate the existing Husky hooks:

```bash
npm run inst
npm run prepare
```

Installation deliberately skips lifecycle scripts, so hook activation is a separate step.
The existing pre-commit hook runs lint-staged.

This machine has an isolated Node.js 24.15.0 and npm 12.1.0 toolchain under
`%LOCALAPPDATA%\OpenFront\toolchain`. Dependencies and Husky hooks are installed.
The system Node.js and npm versions remain unchanged.

In PowerShell, select the project toolchain before running npm commands:

```powershell
$runtime = Join-Path $env:LOCALAPPDATA 'OpenFront\toolchain'
$env:PATH = "$runtime\npm-12\node_modules\.bin;$runtime\node-v24.15.0-win-x64;$env:PATH"
npm.cmd run dev:agents
```

See [AgentArena.md](AgentArena.md) for local AI lobbies, controls, and test commands.

## Agent support

Root and renderer instructions live in `AGENTS.md` files. The corresponding `CLAUDE.md` files point to them.
Codex skill entry points live under `.agents/skills/` and reuse the upstream skill guides and helper scripts.
The skill entry points specify the fork destination and platform differences.

## GitHub workflows

GitHub Actions is disabled for this fork. The inherited workflows include deployments and upstream moderation automation.
Review and adapt these workflows before enabling Actions. No upstream credentials or deployments were configured.
Issues are enabled, and GitHub deletes merged pull request branches automatically.
