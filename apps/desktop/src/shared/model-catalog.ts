import type { CodexModel } from "./ipc";

// Used only when the local CLI has not advertised Astra yet. Keep account
// availability explicit; selecting an ID never grants access to the model.
// https://developers.openai.com/api/docs/models/gpt-6-astra
export const ASTRA_MODEL: CodexModel = {
  id: "gpt-6-astra",
  displayName: "GPT-6 Astra",
  description: "Complex coding, research, and sustained reasoning. Requires Astra access on your account.",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { value: "low", description: "Quick, well-scoped work" },
    { value: "medium", description: "Balanced speed and reasoning depth" },
    { value: "high", description: "Deeper reasoning for complex work" },
    { value: "xhigh", description: "Extra reasoning for difficult, multi-step tasks" },
    { value: "max", description: "Maximum reasoning depth; takes longer and uses more tokens" },
  ],
};

/** Live capabilities always win over the documented manual selection. */
export function codexModelCatalog(models: CodexModel[]): CodexModel[] {
  return models.some((model) => model.id === ASTRA_MODEL.id) ? models : [ASTRA_MODEL, ...models];
}

export function codexDisplayName(model: CodexModel): string {
  return /^gpt-(6-astra|5\.6-(sol|terra|luna))$/i.test(model.id)
    ? model.id.replace(/^gpt-/i, "GPT-").replace(/-(astra|sol|terra|luna)$/i, (_, name: string) => ` ${name[0]!.toUpperCase()}${name.slice(1)}`)
    : model.displayName;
}
