import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const nodePtyRoot = resolve(dirname(require.resolve("node-pty/package.json")));
const helpers = ["darwin-arm64", "darwin-x64"].map((arch) => join(nodePtyRoot, "prebuilds", arch, "spawn-helper"));

for (const helper of helpers) {
  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
  }
}
