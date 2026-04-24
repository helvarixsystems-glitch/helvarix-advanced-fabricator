import {
  SimulationRequest,
  SimulationArtifact,
  StructuralResult,
} from "./types";

import { GmshAdapter } from "./adapters/gmshAdapter";
import { CalculixAdapter } from "./adapters/calculixAdapter";

/**
 * This is the bridge between:
 * - Your GENERATIVE ENGINE
 * - Your SIMULATION ENGINE
 *
 * It builds a full "simulation job package"
 * that can later be:
 * - executed locally
 * - sent to a worker
 * - stored
 * - queued
 */

export interface SimulationJob {
  id: string;
  requestId: string;

  createdAtIso: string;

  geometryArtifacts: SimulationArtifact[];
  solverArtifacts: SimulationArtifact[];

  /**
   * Structured payloads for execution systems
   */
  gmsh?: {
    geoFileName: string;
    geoText: string;
  };

  calculix?: {
    inputFileName: string;
    inputText: string;
  };

  /**
   * Placeholder result until execution layer runs
   */
  preliminaryStructuralResult?: StructuralResult;

  metadata?: Record<string, unknown>;
}

export interface JobBuilderOptions {
  enableGmsh?: boolean;
  enableCalculix?: boolean;
}

/**
 * Core builder function
 */
export function buildSimulationJob(
  request: SimulationRequest,
  options?: JobBuilderOptions
): SimulationJob {
  const jobId = `sim_job_${safeId()}`;

  const gmshEnabled = options?.enableGmsh ?? true;
  const calculixEnabled = options?.enableCalculix ?? true;

  const geometryArtifacts: SimulationArtifact[] = [];
  const solverArtifacts: SimulationArtifact[] = [];

  let gmshPayload: SimulationJob["gmsh"];
  let calculixPayload: SimulationJob["calculix"];
  let preliminaryStructuralResult: StructuralResult | undefined;

  /**
   * STEP 1 — Geometry → Mesh Script (Gmsh)
   */
  if (gmshEnabled && request.structural) {
    const gmsh = new GmshAdapter();

    const bundle = gmsh.buildGeometryBundle({
      jobId,
      geometry: request.geometry,
      mesh: request.structural.mesh,
    });

    geometryArtifacts.push(...bundle.artifacts);

    gmshPayload = {
      geoFileName: bundle.geoFileName,
      geoText: bundle.geoText,
    };
  }

  /**
   * STEP 2 — Mesh → Solver Input (CalculiX)
   */
  if (calculixEnabled && request.structural) {
    const calculix = new CalculixAdapter({
      allowExternalExecution: false,
    });

    const bundle = calculix.buildInputBundle(request);

    solverArtifacts.push(...bundle.artifacts);

    calculixPayload = {
      inputFileName: bundle.inputFileName,
      inputText: bundle.inputText,
    };

    /**
     * Temporary placeholder structural result
     * (until real solver execution layer is wired)
     */
    const result = calculix.runStructural(request);

    if (result instanceof Promise) {
      // safety: avoid awaiting in builder
    } else {
      preliminaryStructuralResult = result.result;
    }
  }

  return {
    id: jobId,
    requestId: request.id,
    createdAtIso: new Date().toISOString(),

    geometryArtifacts,
    solverArtifacts,

    gmsh: gmshPayload,
    calculix: calculixPayload,

    preliminaryStructuralResult,

    metadata: {
      stage: "job-built",
      gmshEnabled,
      calculixEnabled,
    },
  };
}

/**
 * Utility: safe ID generator
 */
function safeId(): string {
  return Math.random().toString(36).slice(2, 10);
}
