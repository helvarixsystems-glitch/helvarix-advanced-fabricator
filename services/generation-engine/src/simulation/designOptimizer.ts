import {
  SimulationRequest,
  SimulationResult,
  SimulationGeometryInput,
  Vec3,
} from "./types";

import {
  runSimulationBatch,
  BatchSimulationResult,
} from "./batchRunner";

export interface OptimizationGoalWeights {
  structural: number;
  thermal: number;
  manufacturability: number;
  cfd: number;
  mass: number;
}

export interface DesignOptimizerOptions {
  generations?: number;
  populationSize?: number;
  survivorsPerGeneration?: number;
  mutationStrength?: number;
  goalWeights?: Partial<OptimizationGoalWeights>;
}

export interface DesignOptimizationGeneration {
  generation: number;
  batch: BatchSimulationResult;
  bestScore: number;
  bestResult?: SimulationResult;
}

export interface DesignOptimizationResult {
  id: string;
  createdAtIso: string;

  baseRequestId: string;
  generations: DesignOptimizationGeneration[];

  bestResult?: SimulationResult;
  bestRequest?: SimulationRequest;

  summary: string;
}

const DEFAULT_WEIGHTS: OptimizationGoalWeights = {
  structural: 0.35,
  thermal: 0.15,
  manufacturability: 0.25,
  cfd: 0.1,
  mass: 0.15,
};

export async function optimizeDesign(
  baseRequest: SimulationRequest,
  options?: DesignOptimizerOptions
): Promise<DesignOptimizationResult> {
  const generations = options?.generations ?? 5;
  const populationSize = options?.populationSize ?? 32;
  const survivorsPerGeneration = options?.survivorsPerGeneration ?? 6;
  const mutationStrength = options?.mutationStrength ?? 0.16;

  const weights: OptimizationGoalWeights = {
    ...DEFAULT_WEIGHTS,
    ...options?.goalWeights,
  };

  const generationResults: DesignOptimizationGeneration[] = [];

  let currentSeed = applyGoalWeightsToRequest(baseRequest, weights);
  let bestResult: SimulationResult | undefined;
  let bestRequest: SimulationRequest | undefined;

  for (let generation = 1; generation <= generations; generation++) {
    const batch = await runSimulationBatch(currentSeed, {
      mode: "hybrid",
      maxCandidates: populationSize,
      keepTop: survivorsPerGeneration,
      mutationStrength,
    });

    const generationBest = batch.bestResult;

    generationResults.push({
      generation,
      batch,
      bestScore: generationBest?.score.total ?? 0,
      bestResult: generationBest,
    });

    if (
      generationBest &&
      (!bestResult || generationBest.score.total > bestResult.score.total)
    ) {
      bestResult = generationBest;
      bestRequest = rebuildRequestFromResult(currentSeed, generationBest);
    }

    if (generationBest) {
      currentSeed = rebuildRequestFromResult(currentSeed, generationBest);
    }
  }

  return {
    id: `optimization_${safeId()}`,
    createdAtIso: new Date().toISOString(),

    baseRequestId: baseRequest.id,
    generations: generationResults,

    bestResult,
    bestRequest,

    summary: bestResult
      ? `Optimization complete. Best score: ${bestResult.score.total}/100 after ${generations} generations.`
      : `Optimization complete, but no valid result was produced.`,
  };
}

function applyGoalWeightsToRequest(
  request: SimulationRequest,
  weights: OptimizationGoalWeights
): SimulationRequest {
  return {
    ...request,
    metadata: {
      ...request.metadata,
      optimizationWeights: weights,
    },
  };
}

function rebuildRequestFromResult(
  seed: SimulationRequest,
  result: SimulationResult
): SimulationRequest {
  /**
   * The fast simulation result currently does not carry full mutated geometry.
   * So this creates a new seed from the previous geometry and applies a small
   * directional refinement.
   *
   * Later, when result artifacts include exact geometry IDs, this function
   * should pull the actual winning geometry directly.
   */
  const current = seed.geometry.boundingBoxMm;

  const structuralScale = result.score.structural >= 80 ? 0.97 : 1.04;
  const massScale = result.score.mass >= 80 ? 0.96 : 1.02;
  const manufacturabilityScale =
    result.score.manufacturability >= 80 ? 0.98 : 1.03;

  const scale = structuralScale * massScale * manufacturabilityScale;

  const nextGeometry: SimulationGeometryInput = {
    ...seed.geometry,
    id: `${seed.geometry.id}_optimized_${safeId()}`,
    name: `${seed.geometry.name} Optimized`,
    boundingBoxMm: mutateToward(current, {
      x: scale,
      y: scale,
      z: scale,
    }),
    volumeMm3: seed.geometry.volumeMm3
      ? seed.geometry.volumeMm3 * scale * scale * scale
      : undefined,
    metadata: {
      ...seed.geometry.metadata,
      optimizedFromResultId: result.id,
      refinementScale: scale,
    },
  };

  return {
    ...seed,
    id: `${seed.id}_optimized_${safeId()}`,
    createdAtIso: new Date().toISOString(),
    geometry: nextGeometry,
    metadata: {
      ...seed.metadata,
      optimizedFromResultId: result.id,
    },
  };
}

function mutateToward(value: Vec3, scale: Vec3): Vec3 {
  return {
    x: clamp(value.x * scale.x, value.x * 0.55, value.x * 1.45),
    y: clamp(value.y * scale.y, value.y * 0.55, value.y * 1.45),
    z: clamp(value.z * scale.z, value.z * 0.55, value.z * 1.45),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeId(): string {
  return Math.random().toString(36).slice(2, 10);
}
