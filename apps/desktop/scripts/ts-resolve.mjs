// Lets `node` run the app's TypeScript directly from scripts/.
//
// Node 22+ strips types on its own, but it will not guess extensions: the app
// source uses bundler-style extensionless imports (`../../shared/ipc`) because
// electron-vite resolves them. This hook fills that one gap so a CLI harness can
// import the real modules instead of a copy that drifts from them.
//
//   node --import ./scripts/ts-resolve.mjs scripts/codex-probe.ts
import { register } from "node:module";

register(new URL("./ts-resolve-hooks.mjs", import.meta.url));
