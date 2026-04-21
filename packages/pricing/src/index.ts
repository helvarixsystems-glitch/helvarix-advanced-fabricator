import { componentRegistry } from "@haf/component-registry";

export function estimateGenerationTokens(partFamily: string): number {
  return componentRegistry.find((item) => item.key === partFamily)?.baseTokenCost ?? 10;
}
