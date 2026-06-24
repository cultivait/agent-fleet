#!/usr/bin/env node
// Preflight: fail FAST and CLEARLY on the wrong Node major instead of letting
// better-sqlite3 crash with an opaque NODE_MODULE_VERSION / ABI mismatch deep in
// hub startup. The native better-sqlite3 addon is compiled against Node 22's ABI
// (process.versions.modules === 127). Running the hub under a different major — the
// old build-22 / pm2-20 / ssh-18 split — throws "compiled against a different Node.js
// version" or segfaults at import time. Pin lives in .nvmrc (22.x).
//
// Wired as `preflight` + `prebuild` + `prestart` in package.json so `npm run build`
// and `npm start` abort with THIS message. For the pm2-launched runtime, pin the
// interpreter to Node 22 — see DEPLOY.md.
const REQUIRED_MAJOR = 22;
const major = Number(process.versions.node.split(".")[0]);

if (major !== REQUIRED_MAJOR) {
  console.error(
    [
      "",
      `  ✗ Agent Fleet requires Node ${REQUIRED_MAJOR}.x — you are on ${process.version}.`,
      "    (better-sqlite3 is a native addon built against Node 22's ABI; another major crashes it.)",
      "",
      "    Fix:",
      "      nvm install && nvm use     # honors .nvmrc (Node 22)",
      "      # or install Node 22.x from https://nodejs.org, then re-run",
      "",
      "    This preflight fails early so you get this message instead of an opaque ABI crash.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
