import {
  SimulationRequest,
  SimulationResult,
} from "./types";

import { executeSimulation } from "./execution/simulationExecutor";
import { buildSimulationReport } from "./reportBuilder";
import { optimizeDesign } from "./designOptimizer";
import { runSimulationBatch } from "./batchRunner";
import { createDefaultBracketSimulationRequest } from "./defaultRequests";

export async function runSingleSimulationApi(
  request?: SimulationRequest
): Promise<{
  request: SimulationRequest;
  result?: SimulationResult;
  reportMarkdown?: string;
  warnings: string[];
  errors: string[];
}> {
  const activeRequest = request ?? createDefaultBracketSimulationRequest();

  const execution = await executeSimulation(activeRequest, {
    mode: "hybrid",
    enableGmsh: true,
    enableCalculix: true,
  });

  const report = execution.result
    ? buildSimulationReport(activeRequest, execution.result)
    : undefined;

  return {
    request: activeRequest,
    result: execution.result,
    reportMarkdown: report?.markdown,
    warnings: execution.warnings,
    errors: execution.errors,
  };
}

export async function runBatchSimulationApi(
  request?: SimulationRequest
) {
  const activeRequest = request ?? createDefaultBracketSimulationRequest();

  return runSimulationBatch(activeRequest, {
    mode: "hybrid",
    maxCandidates: 24,
    keepTop: 8,
    mutationStrength: 0.18,
  });
}

export async function runOptimizationApi(
  request?: SimulationRequest
) {
  const activeRequest = request ?? createDefaultBracketSimulationRequest();

  return optimizeDesign(activeRequest, {
    generations: 5,
    populationSize: 32,
    survivorsPerGeneration: 6,
    mutationStrength: 0.16,
  });
}
