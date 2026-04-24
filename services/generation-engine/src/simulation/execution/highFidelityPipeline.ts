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

import {
  parseCalculixTextOutput,
  mergeCalculixParsedResultIntoStructuralResult,
} from "../parsers";

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

  let calculixOutputText = "";

  if (options?.enableNativeExecution ?? false) {
    if (job.gmsh) {
      const meshFileName = job.gmsh.geoFileName.replace(/\.geo$/i, ".inp");

      const gmshRun = await runSolverCommand(
        buildGmshCommand({
          executable: options?.gmshExecutable,
          cwd: workspace.rootDirectory,
          geoFileName: job.gmsh.geoFileName,
          outputMeshFileName: meshFileName,
          timeoutMs: options?.gmshTimeoutMs,
        })
      );

      solverRuns.push(gmshRun);
      artifacts.push(...gmshRun.artifacts);
      warnings.push(...gmshRun.warnings);
      errors.push(...gmshRun.errors);
    }

    if (job.calculix) {
      const jobName = job.calculix.inputFileName.replace(/\.inp$/i, "");

      const ccxRun = await runSolverCommand(
        buildCalculixCommand({
          executable: options?.calculixExecutable,
          cwd: workspace.rootDirectory,
          jobName,
          timeoutMs: options?.calculixTimeoutMs,
        })
      );

      solverRuns.push(ccxRun);
      artifacts.push(...ccxRun.artifacts);
      warnings.push(...ccxRun.warnings);
      errors.push(...ccxRun.errors);

      calculixOutputText = ccxRun.stdout + "\n" + ccxRun.stderr;
    }
  } else {
    warnings.push(
      "Native solver execution disabled. Using fast simulation fallback."
    );
  }

  /**
   * ALWAYS have fallback
   */
  const fallbackResult = await runSimulation(request);

  let structural: StructuralResult | undefined = fallbackResult.structural;

  /**
   * 🔥 THIS IS THE KEY PART
   * Real solver output → parsed → overrides fast estimate
   */
  if (calculixOutputText) {
    const parsed = parseCalculixTextOutput(calculixOutputText);

    structural = mergeCalculixParsedResultIntoStructuralResult({
      fallback: fallbackResult.structural!,
      parsed,
      yieldStrengthPa: request.material.yieldStrengthPa,
      safetyFactorTarget:
        request.structural?.safetyFactorTarget ?? 2,
    });

    warnings.push(...parsed.warnings);
    errors.push(...parsed.errors);
  }

  const result: SimulationResult = {
    ...fallbackResult,

    structural,

    artifacts: [...fallbackResult.artifacts, ...artifacts],
    warnings: [...fallbackResult.warnings, ...warnings],
    errors: [...fallbackResult.errors, ...errors],

    status:
      errors.length > 0 || fallbackResult.status === "failed"
        ? "failed"
        : "completed",

    summary:
      errors.length > 0
        ? `${fallbackResult.summary} High-fidelity simulation completed with errors.`
        : `${fallbackResult.summary} High-fidelity simulation completed.`,
  };

  return {
    result,
    artifacts,
    solverRuns,
    warnings,
    errors,
  };
}
