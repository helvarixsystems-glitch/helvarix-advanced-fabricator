import {
  SimulationRequest,
  SimulationResult,
  SimulationArtifact,
} from "../types";

import { buildSimulationJob, SimulationJob } from "../jobBuilder";
import { runSimulation } from "../simulationEngine";

/**
 * Execution Modes
 *
 * local:
 *   - Runs everything in-process
 *   - Uses fast estimates + generated artifacts
 *
 * deferred:
 *   - Builds job but does not execute
 *   - Returns job package only
 *
 * hybrid:
 *   - Runs fast estimate immediately
 *   - Returns artifacts for later high-fidelity execution
 */
export type ExecutionMode = "local" | "deferred" | "hybrid";

export interface SimulationExecutionOptions {
  mode?: ExecutionMode;

  enableGmsh?: boolean;
  enableCalculix?: boolean;

  /**
   * Future:
   * - queueName
   * - workerEndpoint
   * - cloud execution config
   */
  metadata?: Record<string, unknown>;
}

export interface SimulationExecutionResult {
  job: SimulationJob;
  result?: SimulationResult;
  artifacts: SimulationArtifact[];

  executionMode: ExecutionMode;

  warnings: string[];
  errors: string[];
}

/**
 * MAIN EXECUTION ENTRY
 *
 * This is what your API / UI should call.
 */
export async function executeSimulation(
  request: SimulationRequest,
  options?: SimulationExecutionOptions
): Promise<SimulationExecutionResult> {
  const mode: ExecutionMode = options?.mode ?? "hybrid";

  const warnings: string[] = [];
  const errors: string[] = [];

  /**
   * STEP 1 — Build job package
   */
  const job = buildSimulationJob(request, {
    enableGmsh: options?.enableGmsh ?? true,
    enableCalculix: options?.enableCalculix ?? true,
  });

  const artifacts: SimulationArtifact[] = [
    ...job.geometryArtifacts,
    ...job.solverArtifacts,
  ];

  /**
   * STEP 2 — Execution modes
   */
  if (mode === "deferred") {
    warnings.push("Simulation execution deferred. Job package created only.");

    return {
      job,
      artifacts,
      executionMode: mode,
      warnings,
      errors,
    };
  }

  /**
   * STEP 3 — Run fast simulation (always available)
   */
  let result: SimulationResult | undefined;

  try {
    result = await runSimulation(request);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  /**
   * STEP 4 — Hybrid mode (future upgrade path)
   */
  if (mode === "hybrid") {
    warnings.push(
      "Hybrid mode: fast simulation completed. High-fidelity solver execution not yet connected."
    );
  }

  /**
   * STEP 5 — Local mode (future real execution hook)
   */
  if (mode === "local") {
    warnings.push(
      "Local mode currently uses internal simulation only. External solver execution not yet enabled."
    );
  }

  /**
   * STEP 6 — Attach result artifacts
   */
  if (result) {
    artifacts.push(...result.artifacts);
  }

  return {
    job,
    result,
    artifacts,

    executionMode: mode,

    warnings,
    errors,
  };
}
