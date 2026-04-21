import { estimateGenerationTokensFromInput } from "@haf/pricing";
import type { GenerationInput, GenerationResult, ValidationMessage } from "@haf/shared";
import { validateConcept } from "@haf/validation";

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function densityFactor(material: string): number {
  switch (material) {
    case "PEEK-CF":
      return 0.72;
    case "AlSi10Mg":
      return 1.05;
    case "Ti-6Al-4V":
      return 1.26;
    case "Inconel 718":
      return 1.35;
    default:
      return 1;
  }
}

function buildFamilyNotes(input: GenerationInput): string[] {
  switch (input.componentFamily) {
    case "nosecone":
      return [
        "Ogive-style conceptual shell generated.",
        "Internal banding assumes two reinforcement zones.",
        "Base transition kept printable for concept-stage additive review."
      ];
    case "shell":
      return [
        "Cylindrical shell concept generated.",
        "Internal brace spacing inferred from length-to-diameter ratio.",
        "Wall continuity optimized for first-pass enclosure study."
      ];
    case "rover-arm":
      return [
        "Segmented arm concept generated.",
        "Joint clearances remain schematic in concept mode.",
        "Load-bearing geometry should receive later structural analysis."
      ];
    case "grid-fin":
      return [
        "Grid-fin frame concept generated.",
        "Lattice density reduced for preview-stage manufacturability.",
        "Thermal and aero loads are not yet simulated."
      ];
  }
}

function estimateMassKg(input: GenerationInput): number {
  const density = densityFactor(input.material);

  switch (input.componentFamily) {
    case "nosecone": {
      const shellProxy =
        (input.lengthMm / 1000) *
        (input.baseDiameterMm / 1000) *
        Math.max(input.wallThicknessMm / 8, 0.2);
      return round(shellProxy * density * 4.9);
    }

    case "shell": {
      const shellProxy =
        (input.lengthMm / 1000) *
        (input.baseDiameterMm / 1000) *
        Math.max(input.wallThicknessMm / 7, 0.24);
      return round(shellProxy * density * 6.2);
    }

    case "rover-arm": {
      const armProxy =
        (input.lengthMm / 1000) *
        Math.max(input.baseDiameterMm / 1000, 0.08) *
        Math.max(input.wallThicknessMm / 5, 0.35);
      return round(armProxy * density * 8.1);
    }

    case "grid-fin": {
      const finProxy =
        (input.lengthMm / 1000) *
        (input.baseDiameterMm / 1000) *
        Math.max(input.wallThicknessMm / 6, 0.25);
      return round(finProxy * density * 7.3);
    }
  }
}

function familyValidation(input: GenerationInput): ValidationMessage[] {
  const messages: ValidationMessage[] = [];

  if (input.componentFamily === "nosecone" && input.lengthMm / input.baseDiameterMm < 2.2) {
    messages.push({
      severity: "warning",
      title: "Nose Profile Ratio",
      text: "Length-to-diameter ratio is low for a slender aerospace nosecone concept."
    });
  }

  if (input.componentFamily === "shell" && input.wallThicknessMm < 3) {
    messages.push({
      severity: "warning",
      title: "Shell Walling",
      text: "Shell wall thickness is thin for a first-pass structural enclosure concept."
    });
  }

  if (input.componentFamily === "rover-arm" && input.material === "PEEK-CF") {
    messages.push({
      severity: "warning",
      title: "Arm Material",
      text: "PEEK-CF may be too conservative for primary rover arm load paths without further analysis."
    });
  }

  if (input.componentFamily === "grid-fin" && input.material === "PEEK-CF") {
    messages.push({
      severity: "error",
      title: "Grid Fin Material",
      text: "PEEK-CF is not a strong conceptual fit for a high-load grid fin path."
    });
  }

  return messages;
}

export function generateConceptGeometry(input: GenerationInput): GenerationResult {
  const estimatedMassKg = estimateMassKg(input);
  const validations = [
    ...validateConcept(input, estimatedMassKg),
    ...familyValidation(input)
  ];

  return {
    revision: "v0.2",
    exportState: "idle",
    estimatedMassKg,
    estimatedBurn: estimateGenerationTokensFromInput(input),
    geometry: {
      silhouette: input.componentFamily,
      lengthMm: input.lengthMm,
      widthMm: input.baseDiameterMm,
      wallThicknessMm: input.wallThicknessMm,
      material: input.material,
      notes: buildFamilyNotes(input)
    },
    validations
  };
}
