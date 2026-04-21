import { componentRegistry } from "@haf/component-registry";
import type { GenerationInput } from "@haf/shared";

export function estimateGenerationTokens(partFamily: string): number {
  return componentRegistry.find((item) => item.key === partFamily)?.baseTokenCost ?? 10;
}

export function estimateGenerationTokensFromInput(input: GenerationInput): number {
  const base = estimateGenerationTokens(input.componentFamily);
  const sizeFactor = Math.max(0, Math.floor(input.lengthMm / 800));
  const materialFactor =
    input.material === "Ti-6Al-4V" || input.material === "Inconel 718" ? 3 : 0;

  return base + sizeFactor + materialFactor;
}
