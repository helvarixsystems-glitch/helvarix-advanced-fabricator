import {
  SimulationRequest,
  SimulationResult,
  SimulationArtifact,
} from "../types";

import {
  RemoteSolverClient,
  RemoteSolverClientOptions,
  RemoteSolverResponse,
} from "./remoteSolverClient";

import { buildSimulationJob, SimulationJob } from "../jobBuilder";
import { runSimulation } from "../simulationEngine";

export interface RemoteExecutionOptions extends RemoteSolverClientOptions {
  /**
   * true:
   *   - submit to remote worker
   *   - return queued/running/completed response
   *
   * false:
   *   - stay fully local and return fast estimate
   */
  enabled: boolean;

  /**
   * If true, run internal estimate immediately even when remote is enabled.
   * This gives users instant feedback while high-fidelity solving happens remotely.
   */
  includeFastEstimate?: boolean;
}

export interface RemoteExecutionResult {
  job: SimulationJob;

  remoteStatus: RemoteSolverResponse["status"];
  remoteJobId?: string;

  fastEstimate?: SimulationResult;
  remoteResult?: SimulationResult;

  artifacts: SimulationArtifact[];

  warnings: string[];
  errors: string[];
}

export async function executeRemoteSimulation(
  request: SimulationRequest,
  options: RemoteExecutionOptions
): Promise<RemoteExecutionResult> {
  const warnings: string[] = [];
  const errors: string[] = [];

  const job = buildSimulationJob(request, {
    enableGmsh: true,
    enableCalculix: true,
  });

  const artifacts: SimulationArtifact[] = [
    ...job.geometryArtifacts,
    ...job.solverArtifacts,
  ];

  let fastEstimate: SimulationResult | undefined;

  if (options.includeFastEstimate ?? true) {
    try {
      fastEstimate = await runSimulation(request);
      artifacts.push(...fastEstimate.artifacts);
    } catch (err) {
      errors.push(
        err instanceof Error
          ? `Fast estimate failed: ${err.message}`
          : `Fast estimate failed: ${String(err)}`
      );
    }
  }

  if (!options.enabled) {
    warnings.push("Remote execution disabled. Returned fast estimate only.");

    return {
      job,
      remoteStatus: "completed",
      fastEstimate,
      artifacts,
      warnings,
      errors,
    };
  }

  const client = new RemoteSolverClient({
    endpointUrl: options.endpointUrl,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
  });

  const remoteResponse = await client.submitSimulation({
    request,
    job,
    artifacts,
  });

  if (remoteResponse.warnings?.length) {
    warnings.push(...remoteResponse.warnings);
  }

  if (remoteResponse.errors?.length) {
    errors.push(...remoteResponse.errors);
  }

  if (remoteResponse.artifacts?.length) {
    artifacts.push(...remoteResponse.artifacts);
  }

  return {
    job,

    remoteStatus: remoteResponse.status,
    remoteJobId: remoteResponse.remoteJobId,

    fastEstimate,
    remoteResult: remoteResponse.result,

    artifacts,

    warnings,
    errors,
  };
}

export async function pollRemoteSimulationResult(
  remoteJobId: string,
  options: RemoteSolverClientOptions
): Promise<RemoteSolverResponse> {
  const client = new RemoteSolverClient(options);
  return client.getSimulationResult(remoteJobId);
}
