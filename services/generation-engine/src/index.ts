import { estimateGenerationTokensFromInput } from "@haf/pricing";
import type { GenerationInput, GenerationResult } from "@haf/shared";
import { validateConcept } from "@haf/validation";

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function generateConceptGeometry(input: GenerationInput): GenerationResult {
  const volumeProxy =
    (input.lengthMm / 1000) *
    (input.baseDiameterMm / 1000) *
    Math.max(input.wallThicknessMm / 10, 0.2);

  const materialDensityFactor =
    input.material === "PEEK-CF"
      ? 0.72
      : input.material === "AlSi10Mg"
        ? 1.05
        : input.material === "Ti-6Al-4V"
          ? 1.26
          : 1.35;

  const estimatedMassKg = round(volumeProxy * materialDensityFactor * 5.4);
  const validations = validateConcept(input, estimatedMassKg);

  return {
    revision: "v0.1",
    exportState: "preview-ready",
    estimatedMassKg,
    estimatedBurn: estimateGenerationTokensFromInput(input),
    geometry: {
      silhouette:
        input.componentFamily === "shell" ||
        input.componentFamily === "rover-arm" ||
        input.componentFamily === "grid-fin"
          ? (input.componentFamily as "shell" | "rover-arm" | "grid-fin")
          : "nosecone",
      lengthMm: input.lengthMm,
      widthMm: input.baseDiameterMm,
      wallThicknessMm: input.wallThicknessMm,
      material: input.material
    },
    validations
  };
}
