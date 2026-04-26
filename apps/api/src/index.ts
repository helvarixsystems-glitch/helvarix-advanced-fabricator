import type {
  ComponentFamily,
  CreditBalance,
  ExportRecord,
  GenerationInput,
  GenerationSummary,
  ProjectSummary,
  StructuralBracketRequirements,
  BellNozzleRequirements
} from "@haf/shared";

import { generateComponent } from "../../../services/generation-engine/src/index";

import { runSimulation } from "../../../services/generation-engine/src/simulation/simulationEngine";
import { buildSimulationJob } from "../../../services/generation-engine/src/simulation/jobBuilder";
import { buildSimulationReport } from "../../../services/generation-engine/src/simulation/reportBuilder";
import { getMaterial } from "../../../services/generation-engine/src/simulation/materials";

import type {
  MaterialSpec,
  SimulationRequest,
  SimulationResult
} from "../../../services/generation-engine/src/simulation/types";

type Env = {
  HELVARIX_SOLVER_URL?: string;
};

type SimulationRecord = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  remoteJobId?: string;
  request: SimulationRequest;
  result?: SimulationResult;
  reportMarkdown?: string;
  warnings: string[];
  errors: string[];
  createdAt: string;
  updatedAt: string;
};

type CreateProjectBody = {
  name: string;
  componentFamily: ComponentFamily;
  workspaceLabel: string;
};

type CreateGenerationBody = {
  projectId: string;
  input: GenerationInput;
  parentGenerationId?: string | null;
};

type CreateIterationBody = {
  projectId: string;
  parentGenerationId: string;
  input: GenerationInput;
};

type QueueExportBody = {
  generationId: string;
  format: "stl" | "step" | "json" | "package";
};

type SimulationProfile = {
  componentFamily: ComponentFamily;
  componentName: string;
  materialName: string;

  lengthMm: number;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  wallThicknessMm: number;
  approximateVolumeMm3: number;
  estimatedMassKg?: number;

  structuralLoadN: number;
  loadDirection: { x: number; y: number; z: number };
  safetyFactorTarget: number;
  maxAllowableDisplacementMm: number;

  manufacturingProcess: "fdm" | "sla" | "sls" | "slm" | "dmls" | "ebm" | "cnc" | "unknown";
  maxOverhangDeg: number;
  minWallThicknessMm: number;
  supportAllowed: boolean;

  thermalEnabled: boolean;
  peakProcessTemperatureC: number;
  distortionSensitivity: number;

  cfdEnabled: boolean;
  cfdFluid: "air" | "water" | "methane" | "oxygen" | "custom";
  cfdVelocityMS: number;
  angleOfAttackDeg: number;

  metadata: Record<string, unknown>;
};

const now = () => new Date().toISOString();

const projects = new Map<string, ProjectSummary>();
const generations = new Map<string, GenerationSummary>();
const exportsMap = new Map<string, ExportRecord>();
const simulations = new Map<string, SimulationRecord>();

const credits: CreditBalance = {
  available: 184,
  reserved: 0
};

const starterProject: ProjectSummary = {
  id: "proj_0001",
  name: "Requirements-First Bracket Study",
  componentFamily: "structural-bracket",
  workspaceLabel: "Fabrication Bay 01",
  createdAt: now(),
  updatedAt: now()
};

projects.set(starterProject.id, starterProject);

const starterInput: GenerationInput = {
  componentFamily: "structural-bracket",
  requirements: {
    componentName: "HAF-BRACKET-01",
    loadCase: {
      forceN: 1000,
      direction: "vertical",
      vibrationHz: 50
    },
    safetyFactor: 2,
    mounting: {
      boltCount: 4,
      boltDiameterMm: 6,
      spacingMm: 40
    },
    envelope: {
      maxWidthMm: 140,
      maxHeightMm: 120,
      maxDepthMm: 60
    },
    manufacturing: {
      process: "additive",
      minWallThicknessMm: 4,
      maxOverhangDeg: 45,
      supportAllowed: true
    },
    objectives: {
      priority: "balanced",
      targetMassKg: 1.2
    }
  }
};

generations.set("gen_0001", {
  id: "gen_0001",
  projectId: starterProject.id,
  parentGenerationId: null,
  componentName: getInputComponentName(starterInput),
  status: "queued",
  tokenCost: 12,
  createdAt: now(),
  updatedAt: now(),
  input: starterInput
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "haf-api",
        solverUrlConfigured: Boolean(env.HELVARIX_SOLVER_URL)
      });
    }

    if (request.method === "GET" && url.pathname === "/credits/balance") {
      return json({ credits });
    }

    if (request.method === "GET" && url.pathname === "/projects") {
      return json({
        projects: Array.from(projects.values()).sort((a, b) =>
          a.updatedAt < b.updatedAt ? 1 : -1
        )
      });
    }

    if (request.method === "POST" && url.pathname === "/projects") {
      const body = await readRequestJson(request);
      const parsed = parseCreateProjectBody(body);

      if (!parsed.ok) {
        return json({ error: parsed.error }, 400);
      }

      const project: ProjectSummary = {
        id: `proj_${Date.now()}`,
        name: parsed.value.name,
        componentFamily: parsed.value.componentFamily,
        workspaceLabel: parsed.value.workspaceLabel,
        createdAt: now(),
        updatedAt: now()
      };

      projects.set(project.id, project);
      return json({ project }, 201);
    }

    if (request.method === "GET" && url.pathname === "/generations") {
      const projectId = url.searchParams.get("projectId");

      const list = Array.from(generations.values())
        .filter((item) => (projectId ? item.projectId === projectId : true))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

      return json({ generations: list });
    }

    if (request.method === "GET" && url.pathname.startsWith("/generations/")) {
      const id = url.pathname.split("/").pop()!;
      const generation = generations.get(id);

      if (!generation) {
        return json({ error: "Generation not found" }, 404);
      }

      return json({
        generation,
        exports: Array.from(exportsMap.values()).filter((item) => item.generationId === id)
      });
    }

    if (request.method === "POST" && url.pathname === "/generations") {
      const body = await readRequestJson(request);
      const parsed = parseCreateGenerationBody(body);

      if (!parsed.ok) {
        return json({ error: parsed.error }, 400);
      }

      const { projectId, input, parentGenerationId } = parsed.value;
      const project = projects.get(projectId);

      if (!project) {
        return json({ error: "Project not found" }, 404);
      }

      const tokenCost = estimateTokenCost(input);

      if (credits.available < tokenCost) {
        return json({ error: "Insufficient credits" }, 400);
      }

      credits.available -= tokenCost;
      credits.reserved += tokenCost;

      const generation: GenerationSummary = {
        id: `gen_${Date.now()}`,
        projectId,
        parentGenerationId: parentGenerationId ?? null,
        componentName: getInputComponentName(input),
        status: "queued",
        tokenCost,
        createdAt: now(),
        updatedAt: now(),
        input
      };

      generations.set(generation.id, generation);

      projects.set(project.id, {
        ...project,
        componentFamily: input.componentFamily,
        updatedAt: now()
      });

      ctx.waitUntil(runGenerationJob(generation.id, tokenCost));

      return json({ generation }, 201);
    }

    if (request.method === "POST" && url.pathname === "/iterations") {
      const body = await readRequestJson(request);
      const parsed = parseCreateIterationBody(body);

      if (!parsed.ok) {
        return json({ error: parsed.error }, 400);
      }

      const parent = generations.get(parsed.value.parentGenerationId);
      if (!parent) {
        return json({ error: "Parent generation not found" }, 404);
      }

      const tokenCost = estimateTokenCost(parsed.value.input);

      if (credits.available < tokenCost) {
        return json({ error: "Insufficient credits" }, 400);
      }

      credits.available -= tokenCost;
      credits.reserved += tokenCost;

      const generation: GenerationSummary = {
        id: `gen_${Date.now()}`,
        projectId: parsed.value.projectId,
        parentGenerationId: parent.id,
        componentName: getInputComponentName(parsed.value.input),
        status: "queued",
        tokenCost,
        createdAt: now(),
        updatedAt: now(),
        input: parsed.value.input
      };

      generations.set(generation.id, generation);
      ctx.waitUntil(runGenerationJob(generation.id, tokenCost));

      return json({ generation }, 201);
    }

    if (request.method === "POST" && url.pathname === "/exports") {
      const body = await readRequestJson(request);
      const parsed = parseQueueExportBody(body);

      if (!parsed.ok) {
        return json({ error: parsed.error }, 400);
      }

      const generation = generations.get(parsed.value.generationId);

      if (!generation || !generation.result) {
        return json({ error: "Generation must be completed before export is queued" }, 400);
      }

      const record: ExportRecord = {
        id: `exp_${Date.now()}`,
        generationId: generation.id,
        status: "queued",
        format: parsed.value.format,
        filename: `${generation.componentName}.${parsed.value.format}`,
        createdAt: now(),
        updatedAt: now()
      };

      exportsMap.set(record.id, record);
      ctx.waitUntil(runExportJob(record.id));

      return json({ export: record }, 201);
    }

    if (request.method === "POST" && url.pathname === "/simulations/run") {
      const body = await readRequestJson(request);

      const input = isRecord(body) && isRecord(body.input)
        ? (body.input as unknown as GenerationInput)
        : null;

      if (!input || !isGenerationInput(input)) {
        return json({ error: "Missing or invalid simulation input" }, 400);
      }

      const simRequest = buildSimulationRequestFromInput(input);
      const simulationId = `sim_${Date.now()}`;

      const record: SimulationRecord = {
        id: simulationId,
        status: "queued",
        request: simRequest,
        warnings: [],
        errors: [],
        createdAt: now(),
        updatedAt: now()
      };

      simulations.set(simulationId, record);

      ctx.waitUntil(runSimulationJob(simulationId, env));

      return json({ id: simulationId, simulation: record }, 201);
    }

    if (request.method === "GET" && url.pathname.startsWith("/simulations/status/")) {
      const id = url.pathname.split("/").pop()!;
      const simulation = simulations.get(id);

      if (!simulation) {
        return json({ error: "Simulation not found" }, 404);
      }

      return json(simulation);
    }

    if (request.method === "GET" && url.pathname.startsWith("/simulations/result/")) {
      const id = url.pathname.split("/").pop()!;
      const simulation = simulations.get(id);

      if (!simulation) {
        return json({ error: "Simulation not found" }, 404);
      }

      return json(simulation);
    }

    return json({ error: "Not found" }, 404);
  }
};

async function runGenerationJob(id: string, tokenCost: number) {
  const queued = generations.get(id);
  if (!queued) return;

  generations.set(id, {
    ...queued,
    status: "running",
    updatedAt: now()
  });

  await delay(900);

  const running = generations.get(id);
  if (!running) return;

  try {
    const result = await generateComponent(running.input);

    credits.reserved = Math.max(0, credits.reserved - tokenCost);

    generations.set(id, {
      ...running,
      status: "completed",
      updatedAt: now(),
      result
    });
  } catch (err) {
    credits.reserved = Math.max(0, credits.reserved - tokenCost);
    credits.available += tokenCost;

    generations.set(id, {
      ...running,
      status: "failed",
      updatedAt: now()
    });

    console.error("Generation failed:", err);
  }
}

async function runExportJob(id: string) {
  const queued = exportsMap.get(id);
  if (!queued) return;

  exportsMap.set(id, {
    ...queued,
    status: "processing",
    updatedAt: now()
  });

  await delay(1500);

  const processing = exportsMap.get(id);
  if (!processing) return;

  exportsMap.set(id, {
    ...processing,
    status: "ready",
    updatedAt: now()
  });
}

async function runSimulationJob(id: string, env: Env) {
  const queued = simulations.get(id);
  if (!queued) return;

  simulations.set(id, {
    ...queued,
    status: "running",
    updatedAt: now()
  });

  const solverUrl = env.HELVARIX_SOLVER_URL?.trim();

  if (solverUrl) {
    try {
      const job = buildSimulationJob(queued.request, {
        enableGmsh: true,
        enableCalculix: true
      });

      const response = await fetch(`${solverUrl.replace(/\/$/, "")}/simulation/submit`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          request: queued.request,
          job,
          artifacts: [...job.geometryArtifacts, ...job.solverArtifacts]
        })
      });

      const submitData = await readJson(response);

      if (!response.ok) {
        throw new Error(getRemoteError(submitData, "Remote solver submission failed."));
      }

      const remoteJobId =
        isRecord(submitData) && typeof submitData.remoteJobId === "string"
          ? submitData.remoteJobId
          : undefined;

      const warnings =
        isRecord(submitData) && Array.isArray(submitData.warnings)
          ? submitData.warnings.map(String)
          : [];

      const errors =
        isRecord(submitData) && Array.isArray(submitData.errors)
          ? submitData.errors.map(String)
          : [];

      simulations.set(id, {
        ...queued,
        status: errors.length > 0 ? "failed" : "running",
        remoteJobId,
        warnings,
        errors,
        updatedAt: now()
      });

      if (remoteJobId && errors.length === 0) {
        await pollRemoteSimulation(id, remoteJobId, solverUrl);
        return;
      }

      throw new Error("Remote solver did not return a usable remoteJobId.");
    } catch (err) {
      const latest = simulations.get(id) ?? queued;

      simulations.set(id, {
        ...latest,
        status: "running",
        warnings: [
          ...latest.warnings,
          `Remote solver unavailable; falling back to internal fast estimate. ${
            err instanceof Error ? err.message : String(err)
          }`
        ],
        updatedAt: now()
      });
    }
  }

  await runLocalSimulationFallback(id);
}

async function runLocalSimulationFallback(id: string) {
  const latest = simulations.get(id);
  if (!latest) return;

  try {
    await delay(600);

    const result = await runSimulation(latest.request);
    const report = buildSimulationReport(latest.request, result);

    simulations.set(id, {
      ...latest,
      status: result.status === "failed" ? "failed" : "completed",
      result,
      reportMarkdown: report.markdown,
      warnings: [...latest.warnings, ...result.warnings],
      errors: result.errors,
      updatedAt: now()
    });
  } catch (err) {
    simulations.set(id, {
      ...latest,
      status: "failed",
      errors: [err instanceof Error ? err.message : String(err)],
      updatedAt: now()
    });
  }
}

async function pollRemoteSimulation(id: string, remoteJobId: string, solverUrl: string) {
  const base = solverUrl.replace(/\/$/, "");

  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(2000);

    const response = await fetch(`${base}/simulation/result/${encodeURIComponent(remoteJobId)}`);
    const data = await readJson(response);

    if (!response.ok) {
      const latest = simulations.get(id);
      if (!latest) return;

      simulations.set(id, {
        ...latest,
        status: "running",
        warnings: [
          ...latest.warnings,
          getRemoteError(data, `Remote solver result request failed: ${response.status}`),
          "Falling back to internal fast estimate."
        ],
        updatedAt: now()
      });

      await runLocalSimulationFallback(id);
      return;
    }

    const latest = simulations.get(id);
    if (!latest) return;

    const remoteStatus =
      isRecord(data) &&
      (data.status === "queued" ||
        data.status === "running" ||
        data.status === "completed" ||
        data.status === "failed")
        ? data.status
        : latest.status;

    const result =
      isRecord(data) && isRecord(data.result)
        ? (data.result as unknown as SimulationResult)
        : latest.result;

    const warnings =
      isRecord(data) && Array.isArray(data.warnings)
        ? data.warnings.map(String)
        : latest.warnings;

    const errors =
      isRecord(data) && Array.isArray(data.errors)
        ? data.errors.map(String)
        : latest.errors;

    const reportMarkdown = result
      ? buildSimulationReport(latest.request, result).markdown
      : latest.reportMarkdown;

    simulations.set(id, {
      ...latest,
      status: remoteStatus,
      result,
      reportMarkdown,
      warnings,
      errors,
      updatedAt: now()
    });

    if (remoteStatus === "completed") {
      return;
    }

    if (remoteStatus === "failed") {
      await runLocalSimulationFallback(id);
      return;
    }
  }

  const latest = simulations.get(id);
  if (!latest) return;

  simulations.set(id, {
    ...latest,
    status: "running",
    warnings: [...latest.warnings, "Remote solver timed out; falling back to internal fast estimate."],
    updatedAt: now()
  });

  await runLocalSimulationFallback(id);
}

function buildSimulationRequestFromInput(input: GenerationInput): SimulationRequest {
  const profile = buildSimulationProfile(input);
  const material = mapMaterial(profile.materialName);

  return {
    id: `sim_request_${Date.now()}`,
    createdAtIso: now(),
    domain: "combined",

    geometry: {
      id: `geo_${Date.now()}`,
      name: profile.componentName,
      primitive: profile.componentFamily === "structural-bracket" ? "bracket" : "custom",
      boundingBoxMm: {
        x: profile.lengthMm,
        y: profile.widthMm,
        z: profile.depthMm
      },
      volumeMm3: profile.approximateVolumeMm3,
      massKg: profile.estimatedMassKg,
      metadata: {
        componentFamily: profile.componentFamily,
        wallThicknessMm: profile.wallThicknessMm,
        heightMm: profile.heightMm,
        ...profile.metadata
      }
    },

    material,

    structural: {
      enabled: true,
      solver: "internal-fast-estimate",
      safetyFactorTarget: profile.safetyFactorTarget,
      maxAllowableDisplacementMm: profile.maxAllowableDisplacementMm,
      mesh: {
        targetElementSizeMm: Math.max(2, profile.wallThicknessMm * 1.2),
        refinementLevel: 2,
        minElementSizeMm: Math.max(0.8, profile.wallThicknessMm * 0.35),
        maxElementSizeMm: Math.max(6, profile.wallThicknessMm * 2.4),
        boundaryLayer: false,
        qualityTarget: 0.72
      },
      loads: [
        {
          id: "primary_load",
          kind: "force",
          label: "Primary requirements-derived design load",
          magnitude: profile.structuralLoadN,
          unit: "N",
          direction: profile.loadDirection,
          targetRegion: "outer-mounting-face"
        }
      ],
      boundaryConditions: [
        {
          id: "fixed_base",
          label: "Fixed mounting interface",
          kind: "fixed",
          targetRegion: "base-mounting-face",
          lockedAxes: ["x", "y", "z"]
        }
      ]
    },

    thermal: {
      enabled: profile.thermalEnabled,
      solver: "internal-fast-estimate",
      ambientTemperatureC: 22,
      buildPlateTemperatureC: profile.manufacturingProcess === "fdm" ? 80 : 120,
      peakProcessTemperatureC: profile.peakProcessTemperatureC,
      coolingRateCPerSec: profile.manufacturingProcess === "fdm" ? 35 : 55,
      distortionSensitivity: profile.distortionSensitivity
    },

    manufacturability: {
      enabled: true,
      process: profile.manufacturingProcess,
      maxOverhangDeg: profile.maxOverhangDeg,
      minWallThicknessMm: profile.minWallThicknessMm,
      minFeatureSizeMm: Math.max(0.8, profile.wallThicknessMm * 0.25),
      preferredBuildAxis: profile.componentFamily === "bell-nozzle" ? "z" : "z",
      allowSupports: profile.supportAllowed,
      supportPenaltyWeight: profile.supportAllowed ? 0.18 : 0.34,
      maxBuildVolumeMm: { x: 300, y: 300, z: 400 }
    },

    cfd: {
      enabled: profile.cfdEnabled,
      solver: "internal-fast-estimate",
      fluid: profile.cfdFluid,
      velocityMS: profile.cfdVelocityMS,
      angleOfAttackDeg: profile.angleOfAttackDeg
    },

    tags: ["frontend", "requirements-first", "simulation", profile.componentFamily],
    metadata: {
      source: "haf-api",
      componentFamily: profile.componentFamily,
      componentName: profile.componentName,
      materialName: profile.materialName,
      requirementsFirst: true
    }
  };
}

function buildSimulationProfile(input: GenerationInput): SimulationProfile {
  if (input.componentFamily === "bell-nozzle") {
    return buildBellNozzleSimulationProfile(input.requirements);
  }

  return buildStructuralSimulationProfile(input.componentFamily, input.requirements);
}

function buildStructuralSimulationProfile(
  family: ComponentFamily,
  requirements: StructuralBracketRequirements
): SimulationProfile {
  const widthMm = positive(requirements.envelope.maxWidthMm, 140);
  const heightMm = positive(requirements.envelope.maxHeightMm, 120);
  const depthMm = positive(requirements.envelope.maxDepthMm, 60);
  const wallThicknessMm = positive(requirements.manufacturing.minWallThicknessMm, 4);

  const loadMultiplier =
    requirements.loadCase.direction === "multi-axis"
      ? 1.35
      : requirements.loadCase.direction === "lateral"
        ? 1.15
        : 1;

  const vibrationMultiplier = requirements.loadCase.vibrationHz
    ? 1 + Math.min(requirements.loadCase.vibrationHz / 700, 0.35)
    : 1;

  const structuralLoadN =
    positive(requirements.loadCase.forceN, 850) * loadMultiplier * vibrationMultiplier;

  const materialName =
    requirements.objectives.priority === "lightweight"
      ? "AlSi10Mg"
      : requirements.objectives.priority === "stiffness"
        ? "Ti-6Al-4V"
        : structuralLoadN > 3500
          ? "Ti-6Al-4V"
          : "AlSi10Mg";

  const approximateVolumeMm3 =
    widthMm * depthMm * wallThicknessMm * 2.2 +
    heightMm * depthMm * wallThicknessMm * 1.8 +
    widthMm * heightMm * wallThicknessMm * 0.8;

  return {
    componentFamily: family,
    componentName: requirements.componentName,
    materialName,

    lengthMm: Math.max(widthMm, heightMm),
    widthMm,
    heightMm,
    depthMm,
    wallThicknessMm,
    approximateVolumeMm3,
    estimatedMassKg: estimateMassKg(approximateVolumeMm3, materialName),

    structuralLoadN,
    loadDirection: loadDirectionToVector(requirements.loadCase.direction),
    safetyFactorTarget: positive(requirements.safetyFactor, 2),
    maxAllowableDisplacementMm: family === "rover-arm" ? 4 : 2.5,

    manufacturingProcess: requirements.manufacturing.process === "additive" ? "slm" : "cnc",
    maxOverhangDeg: positive(requirements.manufacturing.maxOverhangDeg, 45),
    minWallThicknessMm: Math.max(0.8, wallThicknessMm * 0.9),
    supportAllowed: requirements.manufacturing.supportAllowed,

    thermalEnabled: true,
    peakProcessTemperatureC: materialName === "AlSi10Mg" ? 580 : 900,
    distortionSensitivity: materialName === "AlSi10Mg" ? 0.28 : 0.18,

    cfdEnabled: family === "grid-fin",
    cfdFluid: "air",
    cfdVelocityMS: family === "grid-fin" ? 80 : 30,
    angleOfAttackDeg: family === "grid-fin" ? 5 : 0,

    metadata: {
      loadDirection: requirements.loadCase.direction,
      vibrationHz: requirements.loadCase.vibrationHz ?? 0,
      boltCount: requirements.mounting.boltCount,
      boltDiameterMm: requirements.mounting.boltDiameterMm,
      boltSpacingMm: requirements.mounting.spacingMm,
      targetMassKg: requirements.objectives.targetMassKg,
      optimizationPriority: requirements.objectives.priority
    }
  };
}

function buildBellNozzleSimulationProfile(requirements: BellNozzleRequirements): SimulationProfile {
  const lengthMm = positive(requirements.envelope.maxLengthMm, 180);
  const exitDiameterMm = positive(requirements.envelope.maxExitDiameterMm, 110);
  const wallThicknessMm = positive(requirements.manufacturing.minWallThicknessMm, 3);

  const chamberPressureBar = positive(requirements.performance.chamberPressureBar ?? 20, 20);
  const chamberPressurePa = chamberPressureBar * 100_000;
  const projectedAreaM2 = Math.PI * (exitDiameterMm / 2000) ** 2;
  const pressureForceN = chamberPressurePa * projectedAreaM2 * 0.08;

  const materialName =
    requirements.thermal.coolingMode === "regenerative"
      ? "GRCop-42"
      : requirements.thermal.coolingMode === "radiative"
        ? "C103 Niobium Alloy"
        : "Inconel 718";

  const approximateVolumeMm3 =
    Math.PI *
    ((exitDiameterMm / 2) ** 2 - Math.max(exitDiameterMm / 2 - wallThicknessMm, 1) ** 2) *
    lengthMm *
    0.48;

  return {
    componentFamily: "bell-nozzle",
    componentName: requirements.componentName,
    materialName,

    lengthMm,
    widthMm: exitDiameterMm,
    heightMm: exitDiameterMm,
    depthMm: exitDiameterMm,
    wallThicknessMm,
    approximateVolumeMm3,
    estimatedMassKg: estimateMassKg(approximateVolumeMm3, materialName),

    structuralLoadN: Math.max(pressureForceN, requirements.performance.targetThrustN * 0.2),
    loadDirection: { x: 0, y: 0, z: 1 },
    safetyFactorTarget: positive(requirements.safetyFactor, 1.5),
    maxAllowableDisplacementMm: 1.8,

    manufacturingProcess: requirements.manufacturing.process === "additive" ? "slm" : "cnc",
    maxOverhangDeg: 45,
    minWallThicknessMm: Math.max(0.8, wallThicknessMm * 0.9),
    supportAllowed: requirements.manufacturing.supportAllowed,

    thermalEnabled: true,
    peakProcessTemperatureC:
      requirements.thermal.coolingMode === "regenerative"
        ? 820
        : requirements.thermal.coolingMode === "radiative"
          ? 1100
          : 760,
    distortionSensitivity:
      requirements.thermal.coolingMode === "regenerative"
        ? 0.22
        : requirements.thermal.coolingMode === "radiative"
          ? 0.16
          : 0.3,

    cfdEnabled: true,
    cfdFluid:
      requirements.propellant.oxidizer === "LOX"
        ? "oxygen"
        : requirements.propellant.fuel === "CH4"
          ? "methane"
          : "air",
    cfdVelocityMS: Math.max(80, Math.sqrt(requirements.performance.targetThrustN) * 8),
    angleOfAttackDeg: 0,

    metadata: {
      targetThrustN: requirements.performance.targetThrustN,
      burnDurationSec: requirements.performance.burnDurationSec,
      chamberPressureBar,
      ambientPressurePa: requirements.performance.ambientPressurePa,
      oxidizer: requirements.propellant.oxidizer,
      fuel: requirements.propellant.fuel,
      mixtureRatio: requirements.propellant.mixtureRatio,
      coolingMode: requirements.thermal.coolingMode,
      targetMassKg: requirements.objectives.targetMassKg,
      optimizationPriority: requirements.objectives.priority
    }
  };
}

function mapMaterial(material: string): MaterialSpec {
  if (material === "Ti-6Al-4V") return getMaterial("titanium_ti6al4v");
  if (material === "Inconel 718") return getMaterial("inconel_718");
  if (material === "AlSi10Mg") return getMaterial("aluminum_6061_t6");
  if (material === "GRCop-42") return getMaterial("inconel_718");
  if (material === "C103 Niobium Alloy") return getMaterial("inconel_718");
  if (material === "PEEK-CF") return getMaterial("nylon");

  return getMaterial("aluminum_6061_t6");
}

function estimateTokenCost(input: GenerationInput): number {
  if (input.componentFamily === "bell-nozzle") {
    const req = input.requirements;
    const lengthCost = Math.floor(positive(req.envelope.maxLengthMm, 180) / 180);
    const thrustCost = Math.floor(Math.sqrt(positive(req.performance.targetThrustN, 500)) / 16);
    const materialCost = req.thermal.coolingMode === "regenerative" ? 4 : 3;

    return clampInteger(10 + lengthCost + thrustCost + materialCost, 10, 32);
  }

  const req = input.requirements;
  const envelopeCost = Math.floor(
    (positive(req.envelope.maxWidthMm, 140) +
      positive(req.envelope.maxHeightMm, 120) +
      positive(req.envelope.maxDepthMm, 60)) /
      220
  );
  const loadCost = Math.floor(Math.sqrt(positive(req.loadCase.forceN, 850)) / 18);
  const materialCost = req.objectives.priority === "stiffness" ? 3 : 2;

  return clampInteger(10 + envelopeCost + loadCost + materialCost, 10, 28);
}

function estimateMassKg(volumeMm3: number, materialName: string) {
  const densityGcc =
    materialName === "AlSi10Mg"
      ? 2.68
      : materialName === "Ti-6Al-4V"
        ? 4.43
        : materialName === "Inconel 718"
          ? 8.19
          : materialName === "GRCop-42"
            ? 8.85
            : materialName === "C103 Niobium Alloy"
              ? 8.89
              : 2.2;

  return (volumeMm3 / 1_000_000) * densityGcc;
}

function loadDirectionToVector(direction: StructuralBracketRequirements["loadCase"]["direction"]) {
  if (direction === "lateral") return { x: 1, y: 0, z: 0 };
  if (direction === "multi-axis") return { x: 0.58, y: -0.58, z: 0.58 };
  return { x: 0, y: -1, z: 0 };
}

function getInputComponentName(input: GenerationInput) {
  return input.requirements.componentName;
}

function isGenerationInput(value: unknown): value is GenerationInput {
  if (!isRecord(value)) return false;

  const componentFamily = value.componentFamily;

  if (
    componentFamily !== "structural-bracket" &&
    componentFamily !== "bell-nozzle" &&
    componentFamily !== "pressure-vessel" &&
    componentFamily !== "rover-arm" &&
    componentFamily !== "grid-fin"
  ) {
    return false;
  }

  if (!isRecord(value.requirements)) return false;

  return typeof value.requirements.componentName === "string";
}

function parseCreateProjectBody(body: unknown): ParseResult<CreateProjectBody> {
  if (!isRecord(body)) return parseError("Project body must be an object.");

  const name = stringField(body, "name");
  const workspaceLabel = stringField(body, "workspaceLabel");
  const componentFamily = body.componentFamily;

  if (!name) return parseError("Missing project name.");
  if (!workspaceLabel) return parseError("Missing workspace label.");
  if (!isComponentFamily(componentFamily)) return parseError("Invalid component family.");

  return parseOk({
    name,
    workspaceLabel,
    componentFamily
  });
}

function parseCreateGenerationBody(body: unknown): ParseResult<CreateGenerationBody> {
  if (!isRecord(body)) return parseError("Generation body must be an object.");

  const projectId = stringField(body, "projectId");
  const parentGenerationId =
    typeof body.parentGenerationId === "string" ? body.parentGenerationId : null;

  if (!projectId) return parseError("Missing projectId.");
  if (!isGenerationInput(body.input)) return parseError("Invalid generation input.");

  return parseOk({
    projectId,
    parentGenerationId,
    input: body.input
  });
}

function parseCreateIterationBody(body: unknown): ParseResult<CreateIterationBody> {
  if (!isRecord(body)) return parseError("Iteration body must be an object.");

  const projectId = stringField(body, "projectId");
  const parentGenerationId = stringField(body, "parentGenerationId");

  if (!projectId) return parseError("Missing projectId.");
  if (!parentGenerationId) return parseError("Missing parentGenerationId.");
  if (!isGenerationInput(body.input)) return parseError("Invalid generation input.");

  return parseOk({
    projectId,
    parentGenerationId,
    input: body.input
  });
}

function parseQueueExportBody(body: unknown): ParseResult<QueueExportBody> {
  if (!isRecord(body)) return parseError("Export body must be an object.");

  const generationId = stringField(body, "generationId");
  const format = body.format;

  if (!generationId) return parseError("Missing generationId.");

  if (format !== "stl" && format !== "step" && format !== "json" && format !== "package") {
    return parseError("Invalid export format.");
  }

  return parseOk({
    generationId,
    format
  });
}

function isComponentFamily(value: unknown): value is ComponentFamily {
  return (
    value === "structural-bracket" ||
    value === "bell-nozzle" ||
    value === "pressure-vessel" ||
    value === "rover-arm" ||
    value === "grid-fin"
  );
}

type ParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: string;
    };

function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function parseError<T = never>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positive(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.floor(Math.min(max, Math.max(min, value)));
}

async function readRequestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      error: `Non-JSON response from remote service: ${text.slice(0, 240)}`
    };
  }
}

function getRemoteError(data: unknown, fallback: string): string {
  if (isRecord(data)) {
    if (typeof data.error === "string") return data.error;
    if (typeof data.message === "string") return data.message;
    if (Array.isArray(data.errors)) return data.errors.map(String).join(" ");
  }

  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}
