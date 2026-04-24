import type { GenerationInput } from "@haf/shared";

export type PriceEstimate = {
  tokenCost: number;
  reason: string;
};

export function estimateGenerationCost(input: GenerationInput): PriceEstimate {
  if (input.componentFamily === "structural-bracket") {
    const { loadCase, manufacturing, objectives, mounting } = input.requirements;

    const loadCost = Math.ceil(loadCase.forceN / 500);
    const vibrationCost = loadCase.vibrationHz ? Math.ceil(loadCase.vibrationHz / 50) : 0;
    const boltCost = Math.ceil(mounting.boltCount / 2);
    const supportPenalty = manufacturing.supportAllowed ? 1 : 3;
    const optimizationCost =
      objectives.priority === "balanced" ? 3 : objectives.priority === "stiffness" ? 4 : 2;

    const tokenCost = Math.max(
      8,
      loadCost + vibrationCost + boltCost + supportPenalty + optimizationCost
    );

    return {
      tokenCost,
      reason:
        "Requirement-based structural bracket generation priced by load case, vibration requirement, mounting complexity, manufacturability constraint strictness, and optimization priority."
    };
  }

  return {
    tokenCost: 8,
    reason: "Default generation cost."
  };
}

export function estimateIterationCost(input: GenerationInput): PriceEstimate {
  const base = estimateGenerationCost(input);

  return {
    tokenCost: Math.max(4, Math.ceil(base.tokenCost * 0.65)),
    reason: `Iteration discount applied. ${base.reason}`
  };
}
