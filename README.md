![NPM Version](https://img.shields.io/npm/v/1dxway)

# 1dx

One DX Way.

## Install

Run the installer from any Bun project:

```bash
bunx 1dxway
```

1dx uses Ink 8 and requires React 19.3 or later in the host project.
Projects using React types should also use `@types/react` 19.3 or later.

Run the monitor after setup:

```bash
bunx 1dxway start
```

## SQL with Supabase CLI v3

Queries use the project's installed Supabase CLI and target the local stack by default:

```bash
bunx 1dxway sql "SELECT * FROM pg_tables"
bunx 1dxway sql "SELECT * FROM pg_tables" --read-only --remote
bunx 1dxway sql --file ./query.sql --read-only --remote=my-branch
```

Use `--remote` for the linked project, or `--remote=<project-ref|branch|postgres-url>`
for another target. Attach target values with `=`. Hosted reads can use `--read-only`;
hosted writes require an explicit `--yes` for unattended execution. JSON results stay
on stdout, while the CLI's selected target and diagnostics are written to stderr.

The detected preset runs the host project's `supabase:start`, `supabase:up`,
`supabase:up:all`, `supabase:reset`, and `supabase:types` scripts. Keep those scripts
compatible with the installed CLI; local workflows need no `--remote` flag.

## Publish

The repo includes a manual GitHub Actions workflow at `.github/workflows/release.yml`.
Trigger it with `patch`, `minor`, or `major` to:

- bump `package.json`
- typecheck and smoke-test the CLI
- publish to npm with provenance
- push the release commit and tag
- create a GitHub release
