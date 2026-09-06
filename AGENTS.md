# Agent Branch Rules

## Main branch

`feat/server_team` is the main branch. All work starts from it and lands on it.

- Branch off `feat/server_team` for every change (`fix/<topic>`, `feat/<topic>`).
- Target `feat/server_team` with every merge / push. Never target `main`/`master` directly.
- Sync with `origin/feat/server_team` before starting work.

## No unrelated branches

- Never commit unrelated changes onto someone else's feature branch
  (e.g. do not put test fixes, path fixes, or any unrelated work on `feature/dark-mode`).
- Tests belong on the same branch as the change they cover. Do not park tests on unrelated branches.
- Before committing, run `git status` and `git branch --show-current`:
  stage only your own files, and confirm the branch matches the task.
- When in doubt, ask the user which branch to use instead of guessing.
