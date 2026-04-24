import {
  SimulationRequest,
  SimulationResult,
  SimulationArtifact,
  StructuralResult,
} from "../types";

import { buildSimulationJob } from "../jobBuilder";
import { runSimulation } from "../simulationEngine";

import {
  buildSolverWorkspace,
  writeSolverWorkspaceToDisk,
} from "./solverWorkspace";

import {
  buildGmshCommand,
  buildCalculixCommand,
  runSolverCommand,
  SolverRunResult,
} from "./solverRunner";

export interface HighFidelityPipelineOptions {
  enableDiskWrite?: boolean;
  enableNativeExecution?: boolean;

  gmshExecutable?: string;
  calculixExecutable?: string;

  workspaceRootDirectory?: string;

  gmshTimeoutMs?: number;
  calculixTimeoutMs?: number;
}

export interface HighFidelityPipelineResult {
  result: SimulationResult;
  artifacts: SimulationArtifact[];

  solverRuns: SolverRunResult[];

  warnings: string[];
  errors: string[];
}

/**
 * High-Fidelity Pipeline
 *
 * Intended runtime:
 * - remote worker
 * - container
 * - VM
 * - batch compute node
 *
 * Not intended runtime:
 * - browser
 * - Cloudflare Pages
 * - edge function without native process support
 */
export async function runHighFidelityPipeline(
  request: SimulationRequest,
  options?: HighFidelityPipelineOptions
): Promise<HighFidelityPipelineResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const artifacts: SimulationArtifact[] = [];
  const solverRuns: SolverRunResult[] = [];

  const job = buildSimulationJob(request, {
    enableGmsh: true,
    enableCalculix: true,
  });

  artifacts.push(...job.geometryArtifacts, ...job.solverArtifacts);

  const workspace = buildSolverWorkspace({
    workspaceId: job.id,
    gmsh: job.gmsh,
    calculix: job.calculix,
    metadata: {
      requestId: request.id,
      jobId: job.id,
      pipeline: "high-fidelity",
    },
    options: {
      rootDirectory: options?.workspaceRootDirectory,
    },
  });

  artifacts.push(...workspace.artifacts);

  if (options?.enableDiskWrite ?? true) {
    const writeResult = await writeSolverWorkspaceToDisk(workspace);
    warnings.push(...writeResult.warnings);
    errors.push(...writeResult.errors);
  }

  if (options?.enableNativeExecution ?? false) {
    if (job.gmsh) {
      const meshFileName = job.gmsh.geoFileName.replace(/\.geo$/i, ".inp");

      const gmshCommand = buildGmshCommand({
        executable: options?.gmshExecutable,
        cwd: workspace.rootDirectory,
        geoFileName: job.gmsh.geoFileName,
        outputMeshFileName: meshFileName,
        timeoutMs: options?.gmshTimeoutMs,
      });

      const gmshRun = await runSolverCommand(gmshCommand);
      solverRuns.push(gmshRun);
      artifacts.push(...gmshRun.artifacts);
      warnings.push(...gmshRun.warnings);
      errors.push(...gmshRun.errors);
    }

    if (job.calculix) {
      const jobName = job.calculix.inputFileName.replace(/\.inp$/i, "");

      const calculixCommand = buildCalculixCommand({
        executable: options?.calculixExecutable,
        cwd: workspace.rootDirectory,
        jobName,
        timeoutMs: options?.calculixTimeoutMs,
      });

      const ccxRun = await runSolverCommand(calculixCommand);
      solverRuns.push(ccxRun);
      artifacts.push(...ccxRun.artifacts);
      warnings.push(...ccxRun.warnings);
      errors.push(...ccxRun.errors);
    }
  } else {
    warnings.push(
      "Native solver execution disabled. Generated high-fidelity workspace only."
    );
  }

  /**
   * Always return a valid result.
   * Until parser is connected, use the internal simulation as the fallback.
   */
  const fallbackResult = await runSimulation(request);

  const structuralOverride = buildStructuralResultFromSolverRuns(
    fallbackResult.structural,
    solverRuns
  );

  const result: SimulationResult = {
    ...fallbackResult,
    structural: structuralOverride ?? fallbackResult.structural,
    artifacts: [...fallbackResult.artifacts, ...artifacts],
    warnings: [...fallbackResult.warnings, ...warnings],
    errors: [...fallbackResult.errors, ...errors],
    status:
      errors.length > 0 || fallbackResult.status === "failed"
        ? "failed"
        : fallbackResult.status,
    summary:
      errors.length > 0
        ? `${fallbackResult.summary} High-fidelity pipeline completed with errors.`
        : `${fallbackResult.summary} High-fidelity pipeline completed.`,
  };

  return {
    result,
    artifacts,
    solverRuns,
    warnings,
    errors,
  };
}

function buildStructuralResultFromSolverRuns(
  fallback: StructuralResult | undefined,
  solverRuns: SolverRunResult[]
): StructuralResult | undefined {
  if (!fallback) return undefined;

  const calculixRun = solverRuns.find((run) => run.command.kind === "calculix");

  if (!calculixRun) return fallback;

  if (calculixRun.status !== "completed") {
    return {
      ...fallback,
      warnings: [
        ...fallback.warnings,
        "CalculiX did not complete successfully. Structural result uses fast estimate fallback.",
      ],
      solver: "internal-fast-estimate",
    };
  }

  return {
    ...fallback,
    warnings: [
      ...fallback.warnings,
      "CalculiX completed, but result parser is not connected yet. Structural values still use fast estimate fallback.",
    ],
    solver: "calculix",
  };
}
