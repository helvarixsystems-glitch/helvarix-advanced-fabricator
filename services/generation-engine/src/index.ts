import type {
  BaselineComparison,
  BellNozzleRequirements,
  CandidateGeometry,
  ComponentFamily,
  DerivedGeometry,
  GenerationInput,
  GenerationResult,
  RenderableMesh,
  StructuralBracketRequirements,
  ValidationMessage,
  Vec3
} from "@haf/shared";

declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

const DEFAULT_SOLVER_URL = "https://helvarix-solver-worker.onrender.com";
const SOLVER_TIMEOUT_MS = 45_000;

type SolverMeshResponse = {
  ok?: boolean;
  status?: string;
  engine?: string;
  route?: string;
  error?: string;
  message?: string;
  mesh?: unknown;
  renderMesh?: unknown;
  metrics?: Record<string, unknown>;
  candidateId?: string;
};

type SolverMeshCandidate = {
  candidate: CandidateGeometry;
  renderMesh: RenderableMesh;
  solverResponse: SolverMeshResponse;
};

export async function generateComponent(input: GenerationInput): Promise<GenerationResult> {
  if (input.componentFamily === "bell-nozzle") {
    return createNoGeometryResult({
      family: input.componentFamily,
      requirements: normalizeBellNozzleRequirements(input.requirements),
      reason: "Bell-nozzle generation is disabled until it is connected to a real solver-derived geometry pipeline.",
      solverError: "UNSUPPORTED_COMPONENT_SOLVER_PIPELINE"
    });
  }

  return generateStructuralPart(
    input.componentFamily,
    normalizeStructuralRequirements(input.requirements)
  );
}

export const runGeneration = generateComponent;

async function generateStructuralPart(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements
): Promise<GenerationResult> {
  const candidate = buildSingleAuthoritativeCandidate(family, requirements);
  const localConstraintErrors = validatePreSolverConstraints(requirements, candidate);

  if (localConstraintErrors.length > 0) {
    return createNoGeometryResult({
      family,
      requirements,
      candidate,
      reason:
        "No geometry produced. The request failed local pre-solver manufacturability or structural screening, so no viewer mesh was created.",
      solverError: localConstraintErrors.join("; "),
      rejectedCandidates: [
        {
          ...candidate,
          rejected: true,
          rejectionReasons: localConstraintErrors
        }
      ]
    });
  }

  const solverResult = await requestAuthoritativeSolverMesh(requirements, candidate);

  if (!solverResult) {
    return createNoGeometryResult({
      family,
      requirements,
      candidate,
      reason:
        "No geometry produced. The configured solver did not return a valid mesh, and fake TypeScript preview geometry is intentionally disabled.",
      solverError:
        "Expected a solver-derived mesh from /topology/optimize or /topology/mesh. Density-only responses are not accepted as display geometry.",
      rejectedCandidates: [
        {
          ...candidate,
          rejected: true,
          rejectionReasons: [
            "NO_SOLVER_MESH_RETURNED",
            "FAKE_GEOMETRY_DISABLED"
          ]
        }
      ]
    });
  }

  const selected: CandidateGeometry = {
    ...solverResult.candidate,
    rejected: false,
    rejectionReasons: [],
    renderMesh: solverResult.renderMesh,
    derivedParameters: {
      ...solverResult.candidate.derivedParameters,
      geometrySource: "authoritative-solver-mesh",
      solverEngine: solverResult.solverResponse.engine ?? "unknown",
      solverRoute: solverResult.solverResponse.route ?? "topology-mesh",
      fakeGeometryDisabled: true
    }
  };

  const derived: DerivedGeometry = buildDerivedGeometry(selected, solverResult.renderMesh);
  const baselineComparison = buildBaselineComparison(selected.id, 1, 0, 1);

  return {
    revision: "REQ-GEN-010-AUTHORITATIVE-SOLVER-MESH-ONLY",
    exportState: "idle",
    estimatedMassKg: selected.estimatedMassKg,
    estimatedBurn: 1,
    geometry: {
      silhouette: family,
      material: selected.material,
      lengthMm: selected.lengthMm,
      widthMm: selected.widthMm,
      heightMm: selected.heightMm,
      depthMm: selected.depthMm,
      wallThicknessMm: selected.wallThicknessMm,
      skeletonized: true,
      skeletonizationPolicy: "fenics-density",
      openAreaPercent: selected.openAreaPercent,
      loadPathContinuityScore: selected.loadPathContinuityScore,
      renderMesh: solverResult.renderMesh,
      derived,
      candidates: {
        evaluated: 1,
        accepted: 1,
        rejected: 0,
        bestCandidateId: selected.id
      },
      notes: [
        "Authoritative solver mesh received. Viewer geometry is solver-derived, not hand-built TypeScript preview geometry.",
        "Fake decorative fallback geometry is disabled in this generation engine.",
        `Solver engine: ${String(solverResult.solverResponse.engine ?? "unknown")}.`,
        `Mesh: ${solverResult.renderMesh.vertices.length} vertices, ${solverResult.renderMesh.faces.length} faces.`
      ]
    },
    validations: [
      {
        severity: "success",
        title: "Solver geometry produced",
        text:
          "The generation result includes a valid solver-derived renderMesh. This is the only geometry source accepted by this engine."
      },
      {
        severity: "success",
        title: "Presentation fallback disabled",
        text:
          "The generation engine no longer constructs decorative bracket geometry when the solver fails."
      }
    ],
    derived,
    candidatesEvaluated: 1,
    candidatesAccepted: 1,
    candidatesRejected: 0,
    selectedCandidate: selected,
    rejectedCandidates: [],
    baselineComparison,
    fabricationReview: {
      supportRemovalDifficulty: "unknown",
      notes:
        "Fabrication review should be completed after Gmsh/CalculiX validation and export of the solver-derived STL/mesh artifacts."
    }
  };
}

async function requestAuthoritativeSolverMesh(
  requirements: StructuralBracketRequirements,
  candidate: CandidateGeometry
): Promise<SolverMeshCandidate | undefined> {
  const solverUrl = getSolverUrl();
  if (!solverUrl) return undefined;

  const payload = buildTopologySolverPayload(requirements, candidate);
  const endpoints = ["/topology/optimize", "/topology/mesh"];

  for (const endpoint of endpoints) {
    const response = await postToSolver(`${solverUrl.replace(/\/$/, "")}${endpoint}`, payload);
    const mesh = coerceRenderableMesh(response, candidate, requirements);

    if (mesh) {
      const metrics = isRecord(response?.metrics) ? response.metrics : {};
      const updatedCandidate = applySolverMetrics(candidate, metrics, mesh);

      return {
        candidate: updatedCandidate,
        renderMesh: mesh,
        solverResponse: {
          ...(response ?? {}),
          route: endpoint
        }
      };
    }
  }

  return undefined;
}

async function postToSolver(url: string, payload: unknown): Promise<SolverMeshResponse | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOLVER_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const data = (await response.json().catch(() => ({}))) as SolverMeshResponse;

    if (!response.ok) {
      return {
        ok: false,
        error: data.error ?? data.message ?? `Solver returned HTTP ${response.status}`,
        route: url
      };
    }

    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message,
      route: url
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildTopologySolverPayload(
  requirements: StructuralBracketRequirements,
  candidate: CandidateGeometry
) {
  return {
    componentFamily: candidate.family,
    componentName: requirements.componentName,
    candidateId: candidate.id,
    units: "mm",
    objective: "minimum-compliance-topology-optimization",
    requireMesh: true,
    disableFallbackGeometry: true,
    solverPipeline: {
      fenics: true,
      gmsh: true,
      calculix: true
    },
    loadCase: {
      forceN: requirements.loadCase.forceN,
      direction: requirements.loadCase.direction,
      vibrationHz: requirements.loadCase.vibrationHz ?? 0,
      safetyFactor: requirements.safetyFactor
    },
    mounting: {
      boltCount: requirements.mounting.boltCount,
      boltDiameterMm: requirements.mounting.boltDiameterMm,
      spacingMm: requirements.mounting.spacingMm
    },
    envelope: {
      widthMm: candidate.widthMm,
      heightMm: candidate.heightMm,
      depthMm: candidate.depthMm,
      maxWidthMm: requirements.envelope.maxWidthMm,
      maxHeightMm: requirements.envelope.maxHeightMm,
      maxDepthMm: requirements.envelope.maxDepthMm
    },
    manufacturing: {
      process: requirements.manufacturing.process,
      minWallThicknessMm: requirements.manufacturing.minWallThicknessMm,
      maxOverhangDeg: requirements.manufacturing.maxOverhangDeg,
      supportAllowed: requirements.manufacturing.supportAllowed
    },
    objectives: {
      priority: requirements.objectives.priority,
      targetMassKg: requirements.objectives.targetMassKg,
      targetOpenAreaPercent:
        requirements.objectives.targetOpenAreaPercent ?? candidate.openAreaPercent ?? 55
    },
    material: candidate.material
  };
}

function coerceRenderableMesh(
  response: SolverMeshResponse | undefined,
  candidate: CandidateGeometry,
  requirements: StructuralBracketRequirements
): RenderableMesh | undefined {
  if (!response) return undefined;

  const rawMesh = response.renderMesh ?? response.mesh;
  if (!isRecord(rawMesh)) return undefined;

  const vertices = coerceVertices(rawMesh.vertices);
  const faces = coerceFaces(rawMesh.faces);

  if (vertices.length < 4 || faces.length < 1) return undefined;

  return {
    version: "haf-render-mesh-v1",
    units: "mm",
    family: candidate.family,
    vertices,
    faces,
    features: [],
    bounds: {
      widthMm: candidate.widthMm,
      heightMm: candidate.heightMm,
      depthMm: candidate.depthMm
    },
    metadata: {
      candidateId: candidate.id,
      source: "generation-engine",
      boltCount: requirements.mounting.boltCount,
      skeletonized: true
    }
  };
}

function coerceVertices(value: unknown): Vec3[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!Array.isArray(item) || item.length < 3) return undefined;
      const x = finiteOr(Number(item[0]), Number.NaN);
      const y = finiteOr(Number(item[1]), Number.NaN);
      const z = finiteOr(Number(item[2]), Number.NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
      return [x, y, z] as Vec3;
    })
    .filter((item): item is Vec3 => Boolean(item));
}

function coerceFaces(value: unknown): RenderableMesh["faces"] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (Array.isArray(item)) {
        const indices = item.map((entry) => Math.trunc(Number(entry))).filter(Number.isFinite);
        return indices.length >= 3 ? { indices } : undefined;
      }

      if (isRecord(item) && Array.isArray(item.indices)) {
        const indices = item.indices.map((entry) => Math.trunc(Number(entry))).filter(Number.isFinite);
        return indices.length >= 3
          ? {
              indices,
              group: typeof item.group === "string" ? item.group : undefined,
              shade: typeof item.shade === "number" ? item.shade : undefined
            }
          : undefined;
      }

      return undefined;
    })
    .filter((item): item is RenderableMesh["faces"][number] => Boolean(item));
}

function applySolverMetrics(
  candidate: CandidateGeometry,
  metrics: Record<string, unknown>,
  mesh: RenderableMesh
): CandidateGeometry {
  const massKg = readMetric(metrics, ["massKg", "estimatedMassKg", "mass_kg"], candidate.estimatedMassKg);
  const stressMpa = readMetric(metrics, ["maxStressMpa", "estimatedStressMpa", "stressMpa"], candidate.estimatedStressMpa);
  const displacementMm = readMetric(metrics, ["maxDisplacementMm", "estimatedDisplacementMm", "displacementMm"], candidate.estimatedDisplacementMm);
  const safetyFactor = readMetric(metrics, ["safetyFactor", "safetyFactorEstimate"], candidate.safetyFactorEstimate);
  const openAreaPercent = readMetric(metrics, ["openAreaPercent", "voidPercent"], candidate.openAreaPercent ?? 0);

  return {
    ...candidate,
    estimatedMassKg: roundTo(massKg, 0.001),
    estimatedStressMpa: roundTo(stressMpa, 0.01),
    estimatedDisplacementMm: roundTo(displacementMm, 0.0001),
    safetyFactorEstimate: roundTo(safetyFactor, 0.01),
    openAreaPercent: roundTo(openAreaPercent, 0.1),
    renderMesh: mesh,
    derivedParameters: {
      ...candidate.derivedParameters,
      solverVertexCount: mesh.vertices.length,
      solverFaceCount: mesh.faces.length
    }
  };
}

function createNoGeometryResult(args: {
  family: ComponentFamily;
  requirements: StructuralBracketRequirements | BellNozzleRequirements;
  candidate?: CandidateGeometry;
  reason: string;
  solverError: string;
  rejectedCandidates?: CandidateGeometry[];
}): GenerationResult {
  const candidate = args.candidate ?? buildNoGeometryCandidate(args.family, args.requirements);
  const rejectedCandidate: CandidateGeometry = {
    ...candidate,
    rejected: true,
    rejectionReasons: candidate.rejectionReasons.length > 0
      ? candidate.rejectionReasons
      : ["NO_GEOMETRY_PRODUCED", args.solverError],
    renderMesh: undefined,
    derivedParameters: {
      ...candidate.derivedParameters,
      geometrySource: "none",
      fakeGeometryDisabled: true,
      noGeometryReason: args.reason,
      solverError: args.solverError
    }
  };

  const derived: DerivedGeometry = buildDerivedGeometry(rejectedCandidate, undefined);
  const rejectedCandidates = args.rejectedCandidates ?? [rejectedCandidate];
  const baselineComparison = buildBaselineComparison(undefined, 1, 1, 0);

  return {
    revision: "REQ-GEN-010-NO-FAKE-GEOMETRY",
    exportState: "failed",
    estimatedMassKg: 0,
    estimatedBurn: 0,
    geometry: {
      silhouette: args.family,
      material: rejectedCandidate.material,
      lengthMm: rejectedCandidate.lengthMm,
      widthMm: rejectedCandidate.widthMm,
      heightMm: rejectedCandidate.heightMm,
      depthMm: rejectedCandidate.depthMm,
      wallThicknessMm: rejectedCandidate.wallThicknessMm,
      skeletonized: false,
      skeletonizationPolicy: "none",
      openAreaPercent: 0,
      loadPathContinuityScore: 0,
      renderMesh: undefined,
      derived,
      candidates: {
        evaluated: 1,
        accepted: 0,
        rejected: 1
      },
      notes: [
        "NO GEOMETRY PRODUCED.",
        args.reason,
        "The generation engine intentionally refused to create decorative TypeScript fallback geometry.",
        `Solver issue: ${args.solverError}`,
        "Next required backend step: return a real mesh from /topology/optimize or /topology/mesh, then validate it through Gmsh/CalculiX."
      ]
    },
    validations: buildNoGeometryValidations(args.reason, args.solverError),
    derived,
    candidatesEvaluated: 1,
    candidatesAccepted: 0,
    candidatesRejected: 1,
    selectedCandidate: rejectedCandidate,
    rejectedCandidates,
    baselineComparison,
    fabricationReview: {
      supportRemovalDifficulty: "unknown",
      notes:
        "No fabrication review is available because no solver-derived geometry was produced. This is intentional; fake preview geometry is disabled."
    }
  };
}

function buildNoGeometryValidations(reason: string, solverError: string): ValidationMessage[] {
  return [
    {
      severity: "error",
      title: "No solver-derived geometry produced",
      text: reason
    },
    {
      severity: "error",
      title: "Fake geometry disabled",
      text:
        "The generation engine no longer creates hand-built preview brackets when FEniCS/Gmsh/CalculiX do not return a displayable mesh."
    },
    {
      severity: "warning",
      title: "Backend contract required",
      text: `Solver must return renderMesh or mesh with vertices and faces. Current issue: ${solverError}`
    }
  ];
}

function buildSingleAuthoritativeCandidate(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements
): CandidateGeometry {
  const widthMm = Math.max(
    requirements.envelope.maxWidthMm * 0.72,
    requirements.mounting.spacingMm + requirements.mounting.boltDiameterMm * 4.2
  );
  const heightMm = Math.max(requirements.envelope.maxHeightMm * 0.48, requirements.mounting.boltDiameterMm * 7);
  const depthMm = Math.max(requirements.envelope.maxDepthMm * 0.66, requirements.mounting.boltDiameterMm * 3);
  const wallThicknessMm = requirements.manufacturing.minWallThicknessMm;
  const targetOpenAreaPercent = requirements.objectives.targetOpenAreaPercent ?? 55;
  const material = selectMaterialName(requirements);
  const estimatedMassKg = estimateBracketMassKg(widthMm, heightMm, depthMm, wallThicknessMm, targetOpenAreaPercent, material);
  const estimatedStressMpa = estimateStressMpa(requirements, widthMm, wallThicknessMm);
  const safetyFactorEstimate = estimateSafetyFactor(material, estimatedStressMpa);

  return {
    id: "solver_structural_bracket_cand_001",
    family,
    material,
    widthMm: roundTo(widthMm, 0.1),
    heightMm: roundTo(heightMm, 0.1),
    depthMm: roundTo(depthMm, 0.1),
    lengthMm: roundTo(Math.max(widthMm, heightMm), 0.1),
    wallThicknessMm: roundTo(wallThicknessMm, 0.1),
    estimatedMassKg,
    estimatedStressMpa,
    estimatedDisplacementMm: roundTo(requirements.loadCase.forceN / Math.max(widthMm * wallThicknessMm * 18, 1), 0.0001),
    safetyFactorEstimate,
    manufacturabilityScore: 0,
    supportBurdenScore: 0,
    performanceScore: 0,
    totalScore: 0,
    rejected: false,
    rejectionReasons: [],
    skeletonized: true,
    skeletonizationPolicy: "fenics-density",
    openAreaPercent: targetOpenAreaPercent,
    latticeCellCount: 0,
    loadPathContinuityScore: 0,
    renderMesh: undefined,
    derivedParameters: {
      geometrySource: "pending-authoritative-solver-mesh",
      fakeGeometryDisabled: true,
      boltCount: requirements.mounting.boltCount,
      boltDiameterMm: requirements.mounting.boltDiameterMm,
      boltSpacingMm: requirements.mounting.spacingMm,
      targetOpenAreaPercent,
      loadDirection: requirements.loadCase.direction,
      forceN: requirements.loadCase.forceN,
      safetyFactor: requirements.safetyFactor,
      solverRequired: true
    }
  };
}

function buildNoGeometryCandidate(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements | BellNozzleRequirements
): CandidateGeometry {
  if (isStructuralRequirements(requirements)) {
    return buildSingleAuthoritativeCandidate(family, requirements);
  }

  return {
    id: "no_solver_geometry_cand_001",
    family,
    material: "solver-required",
    widthMm: requirements.envelope.maxExitDiameterMm,
    heightMm: requirements.envelope.maxExitDiameterMm,
    depthMm: requirements.envelope.maxLengthMm,
    lengthMm: requirements.envelope.maxLengthMm,
    wallThicknessMm: requirements.manufacturing.minWallThicknessMm,
    estimatedMassKg: 0,
    estimatedStressMpa: 0,
    estimatedDisplacementMm: 0,
    safetyFactorEstimate: 0,
    manufacturabilityScore: 0,
    supportBurdenScore: 0,
    performanceScore: 0,
    totalScore: 0,
    rejected: true,
    rejectionReasons: ["NO_SOLVER_PIPELINE_FOR_COMPONENT"],
    skeletonized: false,
    skeletonizationPolicy: "none",
    openAreaPercent: 0,
    latticeCellCount: 0,
    loadPathContinuityScore: 0,
    renderMesh: undefined,
    derivedParameters: {
      geometrySource: "none",
      fakeGeometryDisabled: true
    }
  };
}

function buildDerivedGeometry(candidate: CandidateGeometry, renderMesh: RenderableMesh | undefined): DerivedGeometry {
  return {
    widthMm: candidate.widthMm,
    heightMm: candidate.heightMm,
    depthMm: candidate.depthMm,
    lengthMm: candidate.lengthMm,
    wallThicknessMm: candidate.wallThicknessMm,
    material: candidate.material,
    estimatedMassKg: candidate.estimatedMassKg,
    selectedCandidateId: candidate.id,
    skeletonized: candidate.skeletonized,
    skeletonizationPolicy: candidate.skeletonizationPolicy,
    openAreaPercent: candidate.openAreaPercent,
    latticeCellCount: candidate.latticeCellCount,
    loadPathContinuityScore: candidate.loadPathContinuityScore,
    renderMesh,
    derivedParameters: candidate.derivedParameters
  };
}

function buildBaselineComparison(
  selectedId: string | undefined,
  evaluated: number,
  rejected: number,
  accepted: number
): BaselineComparison {
  return {
    baselineCandidatesGenerated: evaluated,
    baselineCandidatesSimulated: 0,
    baselineCandidatesRejectedAfterReview: rejected,
    filteredCandidatesGenerated: evaluated,
    filteredCandidatesRejectedBeforeSimulation: rejected,
    filteredCandidatesSimulated: accepted,
    avoidedSimulationRuns: rejected,
    reductionInSimulationLoadPercent: evaluated > 0 ? roundTo((rejected / evaluated) * 100, 0.1) : 0,
    selectedFilteredCandidateId: selectedId,
    selectedBaselineCandidateWasRejected: rejected > 0
  };
}

function validatePreSolverConstraints(
  requirements: StructuralBracketRequirements,
  candidate: CandidateGeometry
): string[] {
  const issues: string[] = [];

  if (requirements.mounting.boltCount < 2) {
    issues.push("Bolt count must be at least 2 for the structural bracket topology demo.");
  }

  if (requirements.mounting.boltDiameterMm <= 0) {
    issues.push("Bolt diameter must be greater than zero.");
  }

  if (requirements.mounting.spacingMm < requirements.mounting.boltDiameterMm * 2.5) {
    issues.push("Bolt spacing is too small for valid mounting interfaces.");
  }

  if (requirements.manufacturing.minWallThicknessMm < 0.8) {
    issues.push("Minimum wall thickness is below the configured manufacturability floor.");
  }

  if (candidate.widthMm > requirements.envelope.maxWidthMm + 0.01) {
    issues.push("Candidate width exceeds envelope.");
  }

  if (candidate.heightMm > requirements.envelope.maxHeightMm + 0.01) {
    issues.push("Candidate height exceeds envelope.");
  }

  if (candidate.depthMm > requirements.envelope.maxDepthMm + 0.01) {
    issues.push("Candidate depth exceeds envelope.");
  }

  return issues;
}

function normalizeStructuralRequirements(requirements: StructuralBracketRequirements): StructuralBracketRequirements {
  const boltDiameterMm = clamp(finiteOr(requirements.mounting.boltDiameterMm, 6), 2, 40);
  const boltCount = Math.round(clamp(finiteOr(requirements.mounting.boltCount, 4), 1, 12));
  const spacingMm = Math.max(finiteOr(requirements.mounting.spacingMm, 48), boltDiameterMm * 2.8);
  const maxWidthMm = Math.max(finiteOr(requirements.envelope.maxWidthMm, 120), spacingMm + boltDiameterMm * 4.2);
  const maxHeightMm = Math.max(finiteOr(requirements.envelope.maxHeightMm, 90), boltDiameterMm * 7);
  const maxDepthMm = Math.max(finiteOr(requirements.envelope.maxDepthMm, 42), boltDiameterMm * 3);
  const minWallThicknessMm = clamp(finiteOr(requirements.manufacturing.minWallThicknessMm, 3), 0.8, maxDepthMm * 0.5);

  return {
    ...requirements,
    loadCase: {
      ...requirements.loadCase,
      forceN: Math.max(finiteOr(requirements.loadCase.forceN, 1000), 1),
      vibrationHz:
        requirements.loadCase.vibrationHz === undefined
          ? undefined
          : Math.max(finiteOr(requirements.loadCase.vibrationHz, 0), 0)
    },
    safetyFactor: clamp(finiteOr(requirements.safetyFactor, 1.5), 1, 6),
    mounting: {
      ...requirements.mounting,
      boltCount,
      boltDiameterMm,
      spacingMm
    },
    envelope: {
      ...requirements.envelope,
      maxWidthMm,
      maxHeightMm,
      maxDepthMm
    },
    manufacturing: {
      ...requirements.manufacturing,
      minWallThicknessMm,
      maxOverhangDeg: clamp(finiteOr(requirements.manufacturing.maxOverhangDeg, 45), 15, 90)
    },
    objectives: {
      ...requirements.objectives,
      targetMassKg:
        requirements.objectives.targetMassKg === undefined
          ? undefined
          : Math.max(finiteOr(requirements.objectives.targetMassKg, 0.1), 0.001),
      targetOpenAreaPercent:
        requirements.objectives.targetOpenAreaPercent === undefined
          ? undefined
          : clamp(finiteOr(requirements.objectives.targetOpenAreaPercent, 55), 10, 82)
    }
  };
}

function normalizeBellNozzleRequirements(requirements: BellNozzleRequirements): BellNozzleRequirements {
  return {
    ...requirements,
    envelope: {
      ...requirements.envelope,
      maxLengthMm: Math.max(finiteOr(requirements.envelope.maxLengthMm, 180), 10),
      maxExitDiameterMm: Math.max(finiteOr(requirements.envelope.maxExitDiameterMm, 80), 10)
    },
    manufacturing: {
      ...requirements.manufacturing,
      minWallThicknessMm: Math.max(finiteOr(requirements.manufacturing.minWallThicknessMm, 2), 0.5)
    }
  };
}

function getSolverUrl() {
  const processEnv = typeof process !== "undefined" ? process.env : undefined;
  return (
    processEnv?.HELVARIX_SOLVER_URL?.trim() ||
    processEnv?.VITE_HELVARIX_SOLVER_URL?.trim() ||
    DEFAULT_SOLVER_URL
  );
}

function selectMaterialName(requirements: StructuralBracketRequirements) {
  if (requirements.manufacturing.process === "additive") return "AlSi10Mg";
  return "7075-T6 Aluminum";
}

function estimateBracketMassKg(
  widthMm: number,
  heightMm: number,
  depthMm: number,
  wallThicknessMm: number,
  openAreaPercent: number,
  material: string
) {
  const densityGcc = material.includes("Al") ? 2.68 : 2.8;
  const solidFraction = clamp(1 - openAreaPercent / 100, 0.18, 0.9);
  const volumeMm3 = widthMm * heightMm * depthMm * solidFraction * clamp(wallThicknessMm / Math.max(depthMm, 1), 0.08, 0.65);
  return roundTo((volumeMm3 / 1_000_000) * densityGcc, 0.001);
}

function estimateStressMpa(requirements: StructuralBracketRequirements, widthMm: number, wallThicknessMm: number) {
  const sectionAreaMm2 = Math.max(widthMm * wallThicknessMm * 0.32, 1);
  const requiredLoadN = requirements.loadCase.forceN * requirements.safetyFactor;
  return roundTo(requiredLoadN / sectionAreaMm2, 0.01);
}

function estimateSafetyFactor(material: string, stressMpa: number) {
  const allowableStressMpa = material.includes("AlSi10Mg") ? 210 : 300;
  return roundTo(allowableStressMpa / Math.max(stressMpa, 0.1), 0.01);
}

function readMetric(metrics: Record<string, unknown>, keys: string[], fallback: number) {
  for (const key of keys) {
    const value = metrics[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return fallback;
}

function isStructuralRequirements(
  requirements: StructuralBracketRequirements | BellNozzleRequirements
): requirements is StructuralBracketRequirements {
  return "mounting" in requirements && "loadCase" in requirements;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteOr(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function roundTo(value: number, step: number) {
  if (!Number.isFinite(value) || step <= 0) return value;
  return Math.round(value / step) * step;
}
