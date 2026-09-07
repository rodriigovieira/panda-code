import { describe, expect, it } from "vitest";
import { ASTRA_MODEL, codexDisplayName, codexModelCatalog } from "./model-catalog";

describe("Codex model catalog", () => {
  it("offers Astra as a manual choice before the CLI advertises it", () => {
    const models = codexModelCatalog([]);
    expect(models[0]?.id).toBe("gpt-6-astra");
    expect(models[0]?.description).toContain("Requires Astra access");
    expect(models[0]?.isDefault).not.toBe(true);
    expect(models[0]?.supportedReasoningEfforts.map((effort) => effort.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("preserves live Astra capabilities and defaults without duplicating it", () => {
    const live = { ...ASTRA_MODEL, isDefault: true, supportedReasoningEfforts: [{ value: "ultra", description: "Live capability" }] };
    const catalog = codexModelCatalog([live]);
    expect(catalog).toEqual([live]);
    expect(catalog[0]).toBe(live);
  });

  it("keeps future and custom models from the CLI", () => {
    const future = { ...ASTRA_MODEL, id: "custom-model", displayName: "Organization model" };
    expect(codexModelCatalog([future])).toContain(future);
    expect(codexDisplayName(future)).toBe("Organization model");
    expect(codexDisplayName({ ...ASTRA_MODEL, id: "gpt-5.6-sol" })).toBe("GPT-5.6 Sol");
  });
});
