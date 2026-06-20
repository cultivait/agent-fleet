# Contributing to Agent Fleet

Thanks for your interest in improving Agent Fleet. Contributions of all kinds are welcome — bug reports, fixes, docs, and features.

## Prerequisites

- Node.js 18 or newer
- npm (ships with Node.js)

## Getting started

```bash
git clone https://github.com/cultivait/agent-fleet.git
cd agent-fleet
npm install
npm run build
```

## Workspace layout

Agent Fleet is an npm workspaces monorepo:

| Path | What it is |
|------|------------|
| `hub/` | The coordination Hub server: message routing, task board, plan graph, and the Cockpit dashboard. |
| `mcp-server/` | The MCP server each agent runs; bridges an agent to the Hub over HTTP. |
| `subsystems/slack-bot/` | Optional Slack bridge (Socket Mode) connecting a Slack workspace to the Hub. |
| `plugin/` | The Claude Code plugin — skills, hooks, and the bundled MCP server shipped to users. |

## Common tasks

```bash
npm run build      # build all workspaces
npm test           # run the test suites across workspaces
npm run bundle     # produce plugin/dist/mcp-server.mjs (single bundled MCP server)
npm run lint       # Biome lint
npm run format     # Biome format
npm run check      # Biome lint + format check (run this before opening a PR)
```

Linting and formatting use [Biome](https://biomejs.dev/). Run `npm run check` before submitting; if it reports fixable issues, `npm run format` and `npm run lint` will resolve most of them.

### Rebuilding the plugin bundle

The plugin ships a pre-bundled single-file MCP server at `plugin/dist/mcp-server.mjs`. If you change anything under `mcp-server/`, rebuild it:

```bash
npm run bundle
```

Commit the regenerated bundle along with your source changes.

### Testing the plugin locally

From the repo root, you can install the plugin from the local checkout:

```
/plugin marketplace add ./
/plugin install agent-fleet@cultivait
```

Use `./` rather than a bare `.` — `.` is rejected as an invalid source. Start a fresh Claude Code session to pick up the change.

## Reporting issues

Open an issue at https://github.com/cultivait/agent-fleet/issues. A good report includes:

- What you expected to happen and what actually happened
- Steps to reproduce
- Your OS and Node.js version (`node --version`)
- Relevant logs from the Hub or the MCP server (with any secrets redacted)

For security vulnerabilities, **do not open a public issue** — see [SECURITY.md](SECURITY.md).

## Opening a pull request

1. Fork the repo and create a branch from `main`.
2. Make your change, with tests where it makes sense.
3. Run `npm run build`, `npm test`, and `npm run check` — all should pass.
4. If you touched the MCP server, run `npm run bundle` and commit the updated bundle.
5. Open a PR against `main` with a clear description of the change and why.

Keep PRs focused — a single logical change per PR is easiest to review.

## Code of conduct

Be respectful and constructive. Assume good faith, and keep discussions focused on the work.
