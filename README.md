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

## Publish

The repo includes a manual GitHub Actions workflow at `.github/workflows/release.yml`.
Trigger it with `patch`, `minor`, or `major` to:

- bump `package.json`
- typecheck and smoke-test the CLI
- publish to npm with provenance
- push the release commit and tag
- create a GitHub release
