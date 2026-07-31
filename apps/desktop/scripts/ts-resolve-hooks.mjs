// Resolve hook: retry an unresolved relative import as `.ts`, then `/index.ts`.
// Only relative specifiers are touched, so package resolution is untouched.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.startsWith(".") || !context.parentURL) {
      throw error;
    }
    for (const suffix of [".ts", "/index.ts"]) {
      const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true, format: "module-typescript" };
      }
    }
    throw error;
  }
}
