---
name: run-openfront
description: Run OpenFront locally and verify game behavior through browser interaction and screenshots.
---

# Run OpenFront with Codex

Read `.claude/skills/run-openfront/SKILL.md` from the repository root for game controls, browser helpers, and verification procedures.
The helper scripts remain in `.claude/skills/run-openfront/`. Their relative imports remain unchanged.

Apply these host-specific rules:

- Check the Node.js and npm requirements in `package.json` before installation.
- Install project dependencies with `npm run inst`. Preserve the npm lockfile.
- Use `npm run dev` for the local client and server at `http://localhost:9000`.
- The original guide describes an Ubuntu host. Do not assume that it describes the current machine.
- Its `setup.sh`, system-library setup, `/tmp` paths, and `pkill` commands are Linux-specific.
- On Windows, use the available browser tools to verify the local game, or run the Linux procedure inside WSL.
- Track the server process started for the task. Stop only that process when finished.
- Save screenshots and relevant game-state observations as verification artifacts.
- Use local development settings. Production and staging commands require explicit user authorization.
