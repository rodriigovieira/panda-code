import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { providerVisibleFiles } from "./providerFiles";
it("excludes tracked secrets, gitignore and pandaignore material from provider context", () => {
 const root = mkdtempSync("/tmp/panda-provider-");
 try {
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".gitignore"), "private.txt\n");
  writeFileSync(join(root, ".pandaignore"), "client-data/**\n");
  expect(providerVisibleFiles(root, ["README.md", "src/app.ts", "private.txt", "client-data/customer.csv", ".env", "secret.json", "cert.pem"])).toEqual(["README.md", "src/app.ts"]);
 } finally { rmSync(root, {recursive:true, force:true}); }
});
