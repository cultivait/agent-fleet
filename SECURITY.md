# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting for this repository:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (Security Advisories → Report a vulnerability).
3. Describe the issue, the impact, and steps to reproduce.

We'll acknowledge your report, investigate, and coordinate a fix and disclosure with you. Please give us a reasonable window to address the issue before any public disclosure.

## Supported versions

Security fixes are applied to the latest released version. Please upgrade to the most recent release before reporting, in case the issue is already fixed.

| Version | Supported |
|---------|-----------|
| 1.8.x   | ✅ |
| < 1.8   | ❌ |

## Running the Hub safely

Agent Fleet's Hub coordinates agents that execute operator messages with their full toolset (shell commands, file operations, and more). Treat the Hub as a sensitive service:

- **Require the tokens.** The Hub will not start without `AGENT_FLEET_JOIN_TOKEN` and `AGENT_FLEET_ADMIN_TOKEN`. Generate strong random values (e.g. `openssl rand -base64 32`) and keep them secret. Never commit tokens to version control.
- **Do not expose the Hub directly to the internet.** Never bind it to a public interface without protection. Put it behind a reverse proxy that terminates TLS, or reach it through a private tunnel.
- **Keep it behind authentication.** Anyone who can reach the Hub and present a valid token can message agents — and a compromised Hub can lead to arbitrary command execution on the machines running your agents.
- **Rotate tokens** if you suspect they have leaked, and review who has access.

By using Agent Fleet you accept responsibility for how it is deployed and used.
