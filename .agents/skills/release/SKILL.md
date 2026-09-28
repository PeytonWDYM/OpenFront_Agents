---
name: release
description: Prepare release notes and draft releases for PeytonWDYM/OpenFront_Agents when the user requests a release or changelog.
---

# Fork releases

Read `.claude/skills/release/SKILL.md` from the repository root for the release procedure.
Apply these overrides to that guide:

- Use `PeytonWDYM/OpenFront_Agents` for every release read, creation, edit, and publication command.
- Pass `--repo PeytonWDYM/OpenFront_Agents` explicitly to GitHub release commands.
- The existing commit script is `.claude/skills/release/scripts/commits.sh`.
  It fetches release refs from `origin` and queries upstream for historical commit attribution.
  Those upstream attribution requests are read-only. They do not authorize upstream writes.
- Inspect inherited pull request numbers in `openfrontio/OpenFrontIO` when attributing upstream changes.
  Inspect fork pull requests in `PeytonWDYM/OpenFront_Agents` for fork changes.
- Forks copy Git tags, but do not copy GitHub release descriptions.
  If this fork has no previous release body, draft a standalone section and explain that the earlier body is unavailable.
- On Windows, use Git Bash or WSL for the Bash commit script.
- Create a draft release only when requested. Publish only after the user explicitly approves publication.

The upstream guide's example repository name never overrides this fork's destination.
