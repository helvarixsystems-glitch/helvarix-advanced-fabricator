import type { GenerationInput } from "@haf/shared";

export type PriceEstimate = {
  tokenCost: number;
  reason: string;
};

export function estimateGenerationCost(input: GenerationInput): PriceEstimate {
  if (input.componentFamily === "bell-nozzle") {
    const { performance, propellant, manufacturing, objectives } = input.requirements;

    const thrustCost = Math.ceil(performance.targetThrustN / 750);
    const burnCost = Math.ceil(performance.burnDurationSec / 20);
    const pressureCost = performance.chamberPressureBar
      ? Math.ceil(performance.chamberPressureBar / 10)
      : 3;
    const propellantCost = propellant.mixtureRatio ? 1 : 2;
    const supportCost = manufacturing.supportAllowed ? 1 : 3;
    const objectiveCost =
      objectives.priority === "balanced" ? 3 : objectives.priority === "compactness" ? 2 : 4;

    return {
      tokenCost: Math.max(
        10,
        thrustCost + burnCost + pressureCost + propellantCost + supportCost + objectiveCost
      ),
      reason:
        "Bell nozzle generation priced by thrust, burn duration, chamber pressure, propellant modeling, manufacturability, and optimization objective."
    };
  }

  const { loadCase, manufacturing, objectives, mounting } = input.requirements;

  const loadCost = Math.ceil(loadCase.forceN / 500);
  const vibrationCost = loadCase.vibrationHz ? Math.ceil(loadCase.vibrationHz / 50) : 0;
  const boltCost = Math.ceil(mounting.boltCount / 2);
  const supportCost = manufacturing.supportAllowed ? 1 : 3;
  const objectiveCost =
    objectives.priority === "balanced" ? 3 : objectives.priority === "stiffness" ? 4 : 2;

  return {
    tokenCost: Math.max(
      8,
      loadCost + vibrationCost + boltCost + supportCost + objectiveCost
    ),
    reason:
      "Requirement-based structural generation priced by load case, vibration, mounting complexity, manufacturability, and optimization priority."
  };
}

export function estimateIterationCost(input: GenerationInput): PriceEstimate {
  const base = estimateGenerationCost(input);

  return {
    tokenCost: Math.max(4, Math.ceil(base.tokenCost * 0.65)),
    reason: `Iteration discount applied. ${base.reason}`
  };
}
