# Agent environment contract

## GitHub credentials — read before touching git or gh

- `GH_TOKEN` and `GITHUB_TOKEN` are **already set in your environment** — the pod injects them from secret `github-token`. Every shell command you run inherits them.
- **Never write `export GH_TOKEN=...` (or any token export) into a terminal command, a script's command line, `.bashrc`, or `.profile`.** Inline credentials trip the pre-exec security scanner ("Sensitive credential exported" = HIGH), which forces a human approval prompt every single session. The export is also redundant: the token is already in your env.
- `gh` and `git` are pre-installed on PATH (`/usr/local/bin/gh`). `git push`, `git fetch`, and `gh api` work with zero setup — just run them.
- `/secrets/token` is a read-only mount of the same token for code that needs a file path. Never cat it into a terminal command.
- If GitHub auth fails, diagnose with `gh api user -q .login` (no exports needed). If that fails, report the failure — rotating the token is an operator action (secret `github-token`, `agents` namespace).

## Dotfiles

`$HOME/.bashrc` and `$HOME/.profile` are scrubbed of credential lines at every pod boot — anything you write there containing tokens is removed on restart. Non-interactive shells don't source `.bashrc` anyway, so env setup there never works for your own commands.
