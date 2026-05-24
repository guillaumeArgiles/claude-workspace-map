# Contributing to Claude Workspace Map

Thanks for taking the time to contribute! This document covers everything you need to know.

---

## How to contribute

### Report a bug

Open a [GitHub Issue](../../issues/new) with:
- What you did
- What you expected
- What actually happened
- Your OS + Node version

### Suggest a feature

Open a [GitHub Discussion](../../discussions/new) before writing code — a quick alignment saves everyone time.

### Submit a pull request

1. Fork the repo and create a branch from `master`
2. Make your changes (see [Development setup](#development-setup) below)
3. Make sure tests pass: `npm test`
4. Make sure TypeScript is happy: `npm run typecheck`
5. Open a PR with a clear description of what and why

---

## Development setup

```bash
git clone https://github.com/guillaumeArgiles/claude-workspace-map.git
cd claude-workspace-map
npm install

# Browser mode (Vite + Node server)
npm run dev

# Electron mode
npm run dev:electron

# Tests
npm test

# Typecheck
npm run typecheck
```

Requires **Node 22+**.

---

## Code style

- TypeScript strict mode — no `any`, no `as unknown`
- No `console.log` in server code — use the `pino` logger (`log.info`, `log.warn`, `log.error`)
- Keep files under ~400 lines — split into modules when they grow
- Tests live next to the code they test (`*.test.ts`)

---

## Contributor License Agreement (lightweight)

By submitting a pull request, you agree that:

1. You have the right to submit the contribution (it's your own work or you have permission).
2. **The copyright holder (Guillaume Argiles) may relicense your contribution under commercial terms** for business partnerships or acquisition, while the open-source version remains available under AGPL v3.

This is a lightweight agreement — no form to sign. Opening a PR constitutes acceptance.

If you are not comfortable with this, please open an Issue to discuss before contributing code.

---

## License

By contributing, your code will be licensed under [AGPL v3](LICENSE) for the open-source release.
