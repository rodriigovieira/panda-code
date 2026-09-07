import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Never auto-send common credentials. .gitignore plus .pandaignore let the
 * workspace owner exclude additional material from the built-in provider. */
export function providerFileDenied(path: string): boolean {
  return path.split(/[\\/]/).some(part => part.startsWith(".") || /^(?:credentials?|secrets?|tokens?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(part) || /\.(?:pem|p8|p12|pfx|key|keystore|mobileprovision)$/i.test(part));
}
export function providerVisibleFiles(cwd: string, paths: string[]): string[] {
  const candidates = paths.filter(path => !providerFileDenied(path));
  if (!candidates.length) return [];
  const args = ["-c", `core.excludesFile=${join(cwd, ".pandaignore")}`, "check-ignore", "--no-index", "--stdin", "-z"];
  let ignored = "";
  try { ignored = execFileSync("git", args, { cwd, input: candidates.join("\0") + "\0", encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 1 && (existsSync(join(cwd, ".git")) || existsSync(join(cwd, ".gitignore")) || existsSync(join(cwd, ".pandaignore")))) return [];
  }
  const excluded = new Set(ignored.split("\0"));
  return candidates.filter(path => !excluded.has(path));
}
