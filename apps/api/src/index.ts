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

    if (request.method === "POST" && url.pathname === "/phase-i/bracket-demo") {
      const input = createPhaseIBracketDemoInput();
      const tokenCost = estimateTokenCost(input);

      if (credits.available < tokenCost) {
        return json({ error: "Insufficient credits" }, 400);
      }

      credits.available -= tokenCost;
      credits.reserved += tokenCost;

      const project: ProjectSummary = {
        id: `proj_phase_i_${Date.now()}`,
        name: "Phase I Bracket Demo",
        componentFamily: "structural-bracket",
        workspaceLabel: "NASA SBIR Phase I Demo",
        createdAt: now(),
        updatedAt: now()
      };

      projects.set(project.id, project);

      const generation: GenerationSummary = {
        id: `gen_phase_i_${Date.now()}`,
        projectId: project.id,
        parentGenerationId: null,
        componentName: getInputComponentName(input),
        status: "queued",
        tokenCost,
        createdAt: now(),
        updatedAt: now(),
        input
      };

      generations.set(generation.id, generation);
      ctx.waitUntil(runGenerationJob(generation.id, tokenCost));

      return json({ project, generation }, 201);
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
async function pollRemoteSimulation(id: string, remoteJobId: string, solverUrl: string) {
  const baseUrl = solverUrl.replace(/\/$/, "");

  for (let attempt = 0; attempt < 18; attempt += 1) {
    await delay(1200);

    const response = await fetch(`${baseUrl}/simulation/status/${encodeURIComponent(remoteJobId)}`);
    const data = await readJson(response);

    if (!response.ok) {
      throw new Error(getRemoteError(data, "Failed to read remote solver status."));
    }

    if (!isRecord(data)) continue;

    const status = typeof data.status === "string" ? data.status : "running";

    if (status === "completed") {
      const resultResponse = await fetch(
        `${baseUrl}/simulation/result/${encodeURIComponent(remoteJobId)}`
      );
      const resultData = await readJson(resultResponse);

      if (!resultResponse.ok) {
        throw new Error(getRemoteError(resultData, "Failed to read remote solver result."));
      }

      const localFallback = await runSimulation(simulations.get(id)!.request);
      const result = isSimulationResult(resultData) ? resultData : localFallback;
      const reportMarkdown = buildSimulationReport(result);

      const latest = simulations.get(id);
      if (!latest) return;

      simulations.set(id, {
        ...latest,
        status: "completed",
        result,
        reportMarkdown,
        warnings: [
          ...latest.warnings,
          ...(isRecord(resultData) && Array.isArray(resultData.warnings)
            ? resultData.warnings.map(String)
            : [])
        ],
        errors: [],
        updatedAt: now()
      });

      return;
    }

    if (status === "failed") {
      throw new Error(getRemoteError(data, "Remote solver job failed."));
    }
  }

  throw new Error("Remote solver timed out before completion.");
}

async function runLocalSimulationFallback(id: string) {
  const record = simulations.get(id);
  if (!record) return;

  try {
    const result = await runSimulation(record.request);
    const reportMarkdown = buildSimulationReport(result);

    simulations.set(id, {
      ...record,
      status: "completed",
      result,
      reportMarkdown,
      errors: [],
      updatedAt: now()
    });
  } catch (err) {
    simulations.set(id, {
      ...record,
      status: "failed",
      errors: [err instanceof Error ? err.message : String(err)],
      updatedAt: now()
    });
  }
}

function buildSimulationRequestFromInput(input: GenerationInput): SimulationRequest {
  const profile = buildSimulationProfile(input);
  const material = getMaterial(profile.materialName) ?? createFallbackMaterial(profile.materialName);

  return {
    id: `simreq_${Date.now()}`,
    name: `${profile.componentName} Simulation`,
    componentFamily: profile.componentFamily,
    material,
    geometry: {
      lengthMm: profile.lengthMm,
      widthMm: profile.widthMm,
      heightMm: profile.heightMm,
      depthMm: profile.depthMm,
      wallThicknessMm: profile.wallThicknessMm,
      approximateVolumeMm3: profile.approximateVolumeMm3,
      estimatedMassKg: profile.estimatedMassKg
    },
    structural: {
      forceN: profile.structuralLoadN,
      direction: profile.loadDirection,
      safetyFactorTarget: profile.safetyFactorTarget,
      maxAllowableDisplacementMm: profile.maxAllowableDisplacementMm
    },
    manufacturing: {
      process: profile.manufacturingProcess,
      maxOverhangDeg: profile.maxOverhangDeg,
      minWallThicknessMm: profile.minWallThicknessMm,
      supportAllowed: profile.supportAllowed
    },
    thermal: {
      enabled: profile.thermalEnabled,
      peakProcessTemperatureC: profile.peakProcessTemperatureC,
      distortionSensitivity: profile.distortionSensitivity
    },
    cfd: {
      enabled: profile.cfdEnabled,
      fluid: profile.cfdFluid,
      velocityMS: profile.cfdVelocityMS,
      angleOfAttackDeg: profile.angleOfAttackDeg
    },
    metadata: profile.metadata
  };
}

function buildSimulationProfile(input: GenerationInput): SimulationProfile {
  if (input.componentFamily === "bell-nozzle") {
    return buildBellNozzleSimulationProfile(input.requirements);
  }

  return buildStructuralSimulationProfile(input.componentFamily, input.requirements);
}

function buildStructuralSimulationProfile(
  componentFamily: ComponentFamily,
  requirements: StructuralBracketRequirements
): SimulationProfile {
  const widthMm = requirements.envelope.maxWidthMm * 0.82;
  const heightMm = requirements.envelope.maxHeightMm * 0.62;
  const depthMm = requirements.envelope.maxDepthMm * 0.72;
  const wallThicknessMm = requirements.manufacturing.minWallThicknessMm * 1.35;

  const approximateVolumeMm3 =
    widthMm * depthMm * wallThicknessMm * 2.1 +
    heightMm * depthMm * wallThicknessMm * 1.45 +
    4 * heightMm * wallThicknessMm * depthMm * 0.26;

  return {
    componentFamily,
    componentName: requirements.componentName,
    materialName: "Ti-6Al-4V",
    lengthMm: Math.max(widthMm, heightMm),
    widthMm,
    heightMm,
    depthMm,
    wallThicknessMm,
    approximateVolumeMm3,
    estimatedMassKg: (approximateVolumeMm3 / 1_000_000) * 4.43,
    structuralLoadN: requirements.loadCase.forceN,
    loadDirection: directionVector(requirements.loadCase.direction),
    safetyFactorTarget: requirements.safetyFactor,
    maxAllowableDisplacementMm: Math.max(0.25, heightMm * 0.01),
    manufacturingProcess: mapManufacturingProcess(requirements.manufacturing.process),
    maxOverhangDeg: requirements.manufacturing.maxOverhangDeg,
    minWallThicknessMm: requirements.manufacturing.minWallThicknessMm,
    supportAllowed: requirements.manufacturing.supportAllowed,
    thermalEnabled: requirements.manufacturing.process === "additive",
    peakProcessTemperatureC: 720,
    distortionSensitivity: 0.32,
    cfdEnabled: false,
    cfdFluid: "air",
    cfdVelocityMS: 0,
    angleOfAttackDeg: 0,
    metadata: {
      source: "requirements",
      boltCount: requirements.mounting.boltCount,
      boltDiameterMm: requirements.mounting.boltDiameterMm,
      boltSpacingMm: requirements.mounting.spacingMm,
      vibrationHz: requirements.loadCase.vibrationHz ?? null,
      objectivePriority: requirements.objectives.priority
    }
  };
}

function buildBellNozzleSimulationProfile(requirements: BellNozzleRequirements): SimulationProfile {
  const lengthMm = requirements.envelope.maxLengthMm * 0.78;
  const widthMm = requirements.envelope.maxExitDiameterMm * 0.86;
  const wallThicknessMm = requirements.manufacturing.minWallThicknessMm * 1.7;

  const approximateVolumeMm3 =
    Math.PI *
    ((widthMm / 2) ** 2 - Math.max(widthMm / 2 - wallThicknessMm, 1) ** 2) *
    lengthMm *
    0.44;

  return {
    componentFamily: "bell-nozzle",
    componentName: requirements.componentName,
    materialName: requirements.thermal.coolingMode === "regenerative" ? "GRCop-42" : "Inconel 718",
    lengthMm,
    widthMm,
    heightMm: widthMm,
    depthMm: widthMm,
    wallThicknessMm,
    approximateVolumeMm3,
    estimatedMassKg: (approximateVolumeMm3 / 1_000_000) * 8.3,
    structuralLoadN: Math.max(requirements.performance.targetThrustN, 1),
    loadDirection: { x: 0, y: 0, z: 1 },
    safetyFactorTarget: requirements.safetyFactor,
    maxAllowableDisplacementMm: Math.max(0.15, lengthMm * 0.006),
    manufacturingProcess: mapManufacturingProcess(requirements.manufacturing.process),
    maxOverhangDeg: 45,
    minWallThicknessMm: requirements.manufacturing.minWallThicknessMm,
    supportAllowed: requirements.manufacturing.supportAllowed,
    thermalEnabled: true,
    peakProcessTemperatureC:
      requirements.thermal.maxWallTemperatureC ??
      (requirements.thermal.coolingMode === "radiative" ? 1050 : 760),
    distortionSensitivity:
      requirements.thermal.coolingMode === "regenerative"
        ? 0.24
        : requirements.thermal.coolingMode === "ablative"
          ? 0.36
          : 0.48,
    cfdEnabled: true,
    cfdFluid: requirements.propellant.oxidizer === "LOX" ? "oxygen" : "custom",
    cfdVelocityMS: Math.sqrt(Math.max(requirements.performance.targetThrustN, 1)) * 8,
    angleOfAttackDeg: 0,
    metadata: {
      source: "requirements",
      targetThrustN: requirements.performance.targetThrustN,
      burnDurationSec: requirements.performance.burnDurationSec,
      chamberPressureBar: requirements.performance.chamberPressureBar ?? null,
      ambientPressurePa: requirements.performance.ambientPressurePa,
      oxidizer: requirements.propellant.oxidizer,
      fuel: requirements.propellant.fuel,
      mixtureRatio: requirements.propellant.mixtureRatio ?? null,
      coolingMode: requirements.thermal.coolingMode,
      objectivePriority: requirements.objectives.priority
    }
  };
}

function directionVector(direction: StructuralBracketRequirements["loadCase"]["direction"]) {
  if (direction === "lateral") {
    return { x: 1, y: 0, z: 0 };
  }

  if (direction === "multi-axis") {
    return { x: 0.577, y: 0.577, z: 0.577 };
  }

  return { x: 0, y: -1, z: 0 };
}

function mapManufacturingProcess(process: "additive" | "machined") {
  return process === "additive" ? "slm" : "cnc";
}

function createFallbackMaterial(name: string): MaterialSpec {
  return {
    name,
    densityKgM3: 4430,
    youngsModulusPa: 114_000_000_000,
    poissonRatio: 0.34,
    yieldStrengthPa: 880_000_000,
    ultimateStrengthPa: 950_000_000,
    thermalExpansion1K: 8.6e-6,
    thermalConductivityWmK: 6.7
  };
}

function createPhaseIBracketDemoInput(): GenerationInput {
  return {
    componentFamily: "structural-bracket",
    requirements: {
      componentName: "PHASE-I-AM-BRACKET-DEMO",
      loadCase: {
        forceN: 1250,
        direction: "multi-axis",
        vibrationHz: 65
      },
      safetyFactor: 2,
      mounting: {
        boltCount: 4,
        boltDiameterMm: 6,
        spacingMm: 42
      },
      envelope: {
        maxWidthMm: 150,
        maxHeightMm: 120,
        maxDepthMm: 64
      },
      manufacturing: {
        process: "additive",
        minWallThicknessMm: 4,
        maxOverhangDeg: 45,
        supportAllowed: true
      },
      objectives: {
        priority: "balanced",
        targetMassKg: 1.15
      }
    }
  };
}

function estimateTokenCost(input: GenerationInput) {
  if (input.componentFamily === "bell-nozzle") {
    const thrust = input.requirements.performance.targetThrustN;
    const burn = input.requirements.performance.burnDurationSec;
    return Math.max(18, Math.min(90, Math.ceil(thrust / 350 + burn / 4)));
  }

  const load = input.requirements.loadCase.forceN;
  const vibration = input.requirements.loadCase.vibrationHz ?? 0;
  return Math.max(10, Math.min(60, Math.ceil(load / 200 + vibration / 15 + 8)));
}

function getInputComponentName(input: GenerationInput) {
  return input.requirements.componentName;
}

async function readRequestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseCreateProjectBody(body: unknown):
  | { ok: true; value: CreateProjectBody }
  | { ok: false; error: string } {
  if (!isRecord(body)) {
    return { ok: false, error: "Invalid JSON body" };
  }

  if (typeof body.name !== "string" || body.name.trim().length < 1) {
    return { ok: false, error: "Project name is required" };
  }

  if (!isComponentFamily(body.componentFamily)) {
    return { ok: false, error: "Valid componentFamily is required" };
  }

  if (typeof body.workspaceLabel !== "string" || body.workspaceLabel.trim().length < 1) {
    return { ok: false, error: "workspaceLabel is required" };
  }

  return {
    ok: true,
    value: {
      name: body.name.trim(),
      componentFamily: body.componentFamily,
      workspaceLabel: body.workspaceLabel.trim()
    }
  };
}

function parseCreateGenerationBody(body: unknown):
  | { ok: true; value: CreateGenerationBody }
  | { ok: false; error: string } {
  if (!isRecord(body)) {
    return { ok: false, error: "Invalid JSON body" };
  }

  if (typeof body.projectId !== "string" || body.projectId.trim().length < 1) {
    return { ok: false, error: "projectId is required" };
  }

  if (!isRecord(body.input) || !isGenerationInput(body.input)) {
    return { ok: false, error: "Valid generation input is required" };
  }

  return {
    ok: true,
    value: {
      projectId: body.projectId,
      input: body.input,
      parentGenerationId:
        typeof body.parentGenerationId === "string" ? body.parentGenerationId : null
    }
  };
}

function parseCreateIterationBody(body: unknown):
  | { ok: true; value: CreateIterationBody }
  | { ok: false; error: string } {
  if (!isRecord(body)) {
    return { ok: false, error: "Invalid JSON body" };
  }

  if (typeof body.projectId !== "string" || body.projectId.trim().length < 1) {
    return { ok: false, error: "projectId is required" };
  }

  if (
    typeof body.parentGenerationId !== "string" ||
    body.parentGenerationId.trim().length < 1
  ) {
    return { ok: false, error: "parentGenerationId is required" };
  }

  if (!isRecord(body.input) || !isGenerationInput(body.input)) {
    return { ok: false, error: "Valid generation input is required" };
  }

  return {
    ok: true,
    value: {
      projectId: body.projectId,
      parentGenerationId: body.parentGenerationId,
      input: body.input
    }
  };
}

function parseQueueExportBody(body: unknown):
  | { ok: true; value: QueueExportBody }
  | { ok: false; error: string } {
  if (!isRecord(body)) {
    return { ok: false, error: "Invalid JSON body" };
  }

  if (typeof body.generationId !== "string" || body.generationId.trim().length < 1) {
    return { ok: false, error: "generationId is required" };
  }

  if (
    body.format !== "stl" &&
    body.format !== "step" &&
    body.format !== "json" &&
    body.format !== "package"
  ) {
    return { ok: false, error: "format must be stl, step, json, or package" };
  }

  return {
    ok: true,
    value: {
      generationId: body.generationId,
      format: body.format
    }
  };
}

function isGenerationInput(value: unknown): value is GenerationInput {
  if (!isRecord(value)) return false;

  if (!isComponentFamily(value.componentFamily)) return false;
  if (!isRecord(value.requirements)) return false;

  if (value.componentFamily === "bell-nozzle") {
    return isBellNozzleRequirements(value.requirements);
  }

  return isStructuralBracketRequirements(value.requirements);
}

function isStructuralBracketRequirements(value: unknown): value is StructuralBracketRequirements {
  if (!isRecord(value)) return false;
  if (typeof value.componentName !== "string") return false;
  if (!isRecord(value.loadCase)) return false;
  if (!isRecord(value.mounting)) return false;
  if (!isRecord(value.envelope)) return false;
  if (!isRecord(value.manufacturing)) return false;
  if (!isRecord(value.objectives)) return false;

  return (
    typeof value.loadCase.forceN === "number" &&
    (value.loadCase.direction === "vertical" ||
      value.loadCase.direction === "lateral" ||
      value.loadCase.direction === "multi-axis") &&
    typeof value.safetyFactor === "number" &&
    typeof value.mounting.boltCount === "number" &&
    typeof value.mounting.boltDiameterMm === "number" &&
    typeof value.mounting.spacingMm === "number" &&
    typeof value.envelope.maxWidthMm === "number" &&
    typeof value.envelope.maxHeightMm === "number" &&
    typeof value.envelope.maxDepthMm === "number" &&
    (value.manufacturing.process === "additive" || value.manufacturing.process === "machined") &&
    typeof value.manufacturing.minWallThicknessMm === "number" &&
    typeof value.manufacturing.maxOverhangDeg === "number" &&
    typeof value.manufacturing.supportAllowed === "boolean" &&
    (value.objectives.priority === "lightweight" ||
      value.objectives.priority === "stiffness" ||
      value.objectives.priority === "balanced")
  );
}

function isBellNozzleRequirements(value: unknown): value is BellNozzleRequirements {
  if (!isRecord(value)) return false;
  if (typeof value.componentName !== "string") return false;
  if (!isRecord(value.performance)) return false;
  if (!isRecord(value.propellant)) return false;
  if (!isRecord(value.envelope)) return false;
  if (!isRecord(value.thermal)) return false;
  if (!isRecord(value.manufacturing)) return false;
  if (!isRecord(value.objectives)) return false;

  return (
    typeof value.performance.targetThrustN === "number" &&
    typeof value.performance.burnDurationSec === "number" &&
    typeof value.performance.ambientPressurePa === "number" &&
    (value.propellant.oxidizer === "LOX" ||
      value.propellant.oxidizer === "N2O" ||
      value.propellant.oxidizer === "H2O2") &&
    (value.propellant.fuel === "RP1" ||
      value.propellant.fuel === "CH4" ||
      value.propellant.fuel === "H2" ||
      value.propellant.fuel === "HTPB") &&
    typeof value.envelope.maxLengthMm === "number" &&
    typeof value.envelope.maxExitDiameterMm === "number" &&
    (value.thermal.coolingMode === "ablative" ||
      value.thermal.coolingMode === "regenerative" ||
      value.thermal.coolingMode === "radiative") &&
    (value.manufacturing.process === "additive" || value.manufacturing.process === "machined") &&
    typeof value.manufacturing.minWallThicknessMm === "number" &&
    typeof value.manufacturing.supportAllowed === "boolean" &&
    (value.objectives.priority === "efficiency" ||
      value.objectives.priority === "compactness" ||
      value.objectives.priority === "thermal-margin" ||
      value.objectives.priority === "balanced") &&
    typeof value.safetyFactor === "number"
  );
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

function isSimulationResult(value: unknown): value is SimulationResult {
  return (
    isRecord(value) &&
    isRecord(value.summary) &&
    isRecord(value.structural) &&
    Array.isArray(value.warnings) &&
    Array.isArray(value.errors)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRemoteError(value: unknown, fallback: string) {
  if (isRecord(value) && typeof value.error === "string") {
    return value.error;
  }

  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }

  return fallback;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
