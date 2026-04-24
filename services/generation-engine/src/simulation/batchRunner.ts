import {
  SimulationRequest,
  SimulationResult,
  SimulationGeometryInput,
  Vec3,
} from "./types";

import { executeSimulation, SimulationExecutionOptions } from "./execution/simulationExecutor";

export interface BatchRunnerOptions extends SimulationExecutionOptions {
  maxCandidates?: number;
  keepTop?: number;
  mutationStrength?: number;
}

export interface BatchSimulationResult {
  id: string;
  createdAtIso: string;

  baseRequestId: string;
  totalCandidates: number;

  results: SimulationResult[];
  rankedResults: SimulationResult[];

  bestResult?: SimulationResult;

  summary: string;
}

export async function runSimulationBatch(
  baseRequest: SimulationRequest,
  options?: BatchRunnerOptions
): Promise<BatchSimulationResult> {
  const maxCandidates = options?.maxCandidates ?? 24;
  const keepTop = options?.keepTop ?? 8;
  const mutationStrength = options?.mutationStrength ?? 0.18;

  const candidateRequests = generateCandidateRequests(
    baseRequest,
    maxCandidates,
    mutationStrength
  );

  const results: SimulationResult[] = [];

  for (const candidate of candidateRequests) {
    const execution = await executeSimulation(candidate, {
      ...options,
      mode: options?.mode ?? "hybrid",
    });

    if (execution.result) {
      results.push(execution.result);
    }
  }

  const rankedResults = [...results]
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, keepTop);

  const bestResult = rankedResults[0];

  return {
    id: `batch_${safeId()}`,
    createdAtIso: new Date().toISOString(),

    baseRequestId: baseRequest.id,
    totalCandidates: candidateRequests.length,

    results,
    rankedResults,
    bestResult,

    summary: bestResult
      ? `Batch complete. Best score: ${bestResult.score.total}/100 from ${results.length} completed simulations.`
      : `Batch complete, but no valid simulation results were produced.`,
  };
}

export function generateCandidateRequests(
  baseRequest: SimulationRequest,
  count: number,
  mutationStrength = 0.15
): SimulationRequest[] {
  const candidates: SimulationRequest[] = [];

  for (let i = 0; i < count; i++) {
    const scale = randomMutationScale(mutationStrength);

    const mutatedGeometry: SimulationGeometryInput = {
      ...baseRequest.geometry,
      id: `${baseRequest.geometry.id}_candidate_${i + 1}`,
      name: `${baseRequest.geometry.name} Candidate ${i + 1}`,
      boundingBoxMm: mutateVec3(baseRequest.geometry.boundingBoxMm, scale),
      volumeMm3: baseRequest.geometry.volumeMm3
        ? baseRequest.geometry.volumeMm3 * scale.x * scale.y * scale.z
        : undefined,
      metadata: {
        ...baseRequest.geometry.metadata,
        candidateIndex: i + 1,
        mutationScale: scale,
      },
    };

    candidates.push({
      ...baseRequest,
      id: `${baseRequest.id}_candidate_${i + 1}_${safeId()}`,
      createdAtIso: new Date().toISOString(),
      geometry: mutatedGeometry,
      metadata: {
        ...baseRequest.metadata,
        candidateIndex: i + 1,
        generatedBy: "simulation-batch-runner",
      },
    });
  }

  return candidates;
}

function randomMutationScale(strength: number): Vec3 {
  return {
    x: 1 + randomSigned(strength),
    y: 1 + randomSigned(strength),
    z: 1 + randomSigned(strength),
  };
}

function mutateVec3(value: Vec3, scale: Vec3): Vec3 {
  return {
    x: clamp(value.x * scale.x, value.x * 0.45, value.x * 1.8),
    y: clamp(value.y * scale.y, value.y * 0.45, value.y * 1.8),
    z: clamp(value.z * scale.z, value.z * 0.45, value.z * 1.8),
  };
}

function randomSigned(amount: number): number {
  return (Math.random() * 2 - 1) * amount;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function safeId(): string {
  return Math.random().toString(36).slice(2, 10);
}
