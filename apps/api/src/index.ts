import {
  createGenerationSchema,
  createIterationSchema,
  projectSchema,
  queueExportSchema
} from "@haf/schemas";
import type {
  CreditBalance,
  ExportRecord,
  GenerationInput,
  GenerationSummary,
  ProjectSummary
} from "@haf/shared";
import { generateConceptGeometry } from "../../../services/generation-engine/src/index";

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
  name: "Lunar Nosecone Study",
  componentFamily: "nosecone",
  workspaceLabel: "Fabrication Bay 01",
  createdAt: now(),
  updatedAt: now()
};

projects.set(starterProject.id, starterProject);

const starterInput: GenerationInput = {
  componentFamily: "nosecone",
  componentName: "HAF-NC-01",
  lengthMm: 1200,
  baseDiameterMm: 320,
  wallThicknessMm: 3.4,
  material: "PEEK-CF",
  targetMassKg: 8.6
};

generations.set("gen_0001", {
  id: "gen_0001",
  projectId: starterProject.id,
  parentGenerationId: null,
  componentName: starterInput.componentName,
  status: "completed",
  tokenCost: 12,
  createdAt: now(),
  updatedAt: now(),
  input: starterInput,
  result: generateConceptGeometry(starterInput)
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
      const body = await request.json();
      const parsed = projectSchema.safeParse(body);

      if (!parsed.success) {
        return json({ error: parsed.error.flatten() }, 400);
      }

      const project: ProjectSummary = {
        id: `proj_${Date.now()}`,
        name: parsed.data.name,
        componentFamily: parsed.data.componentFamily,
        workspaceLabel: parsed.data.workspaceLabel,
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
      const body = await request.json();
      const parsed = createGenerationSchema.safeParse(body);

      if (!parsed.success) {
        return json({ error: parsed.error.flatten() }, 400);
      }

      const { projectId, input, parentGenerationId } = parsed.data;
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
        componentName: input.componentName,
        status: "queued",
        tokenCost,
        createdAt: now(),
        updatedAt: now(),
        input
      };

      generations.set(generation.id, generation);

      projects.set(project.id, {
        ...project,
        updatedAt: now()
      });

      ctx.waitUntil(runGenerationJob(generation.id, tokenCost));

      return json({ generation }, 201);
    }

    if (request.method === "POST" && url.pathname === "/iterations") {
      const body = await request.json();
      const parsed = createIterationSchema.safeParse(body);

      if (!parsed.success) {
        return json({ error: parsed.error.flatten() }, 400);
      }

      const parent = generations.get(parsed.data.parentGenerationId);
      if (!parent) {
        return json({ error: "Parent generation not found" }, 404);
      }

      const tokenCost = estimateTokenCost(parsed.data.input);

      if (credits.available < tokenCost) {
        return json({ error: "Insufficient credits" }, 400);
      }

      credits.available -= tokenCost;
      credits.reserved += tokenCost;

      const generation: GenerationSummary = {
        id: `gen_${Date.now()}`,
        projectId: parsed.data.projectId,
        parentGenerationId: parent.id,
        componentName: parsed.data.input.componentName,
        status: "queued",
        tokenCost,
        createdAt: now(),
        updatedAt: now(),
        input: parsed.data.input
      };

      generations.set(generation.id, generation);
      ctx.waitUntil(runGenerationJob(generation.id, tokenCost));

      return json({ generation }, 201);
    }

    if (request.method === "POST" && url.pathname === "/exports") {
      const body = await request.json();
      const parsed = queueExportSchema.safeParse(body);

      if (!parsed.success) {
        return json({ error: parsed.error.flatten() }, 400);
      }

      const generation = generations.get(parsed.data.generationId);

      if (!generation || !generation.result) {
        return json({ error: "Generation must be completed before export is queued" }, 400);
      }

      const record: ExportRecord = {
        id: `exp_${Date.now()}`,
        generationId: generation.id,
        status: "queued",
        format: parsed.data.format,
        filename: `${generation.componentName}.${parsed.data.format}`,
        createdAt: now(),
        updatedAt: now()
      };

      exportsMap.set(record.id, record);
      ctx.waitUntil(runExportJob(record.id));

      return json({ export: record }, 201);
    }

    if (request.method === "POST" && url.pathname === "/simulations/run") {
      const body = await request.json();

      const input = isRecord(body) && isRecord(body.input)
        ? (body.input as unknown as GenerationInput)
        : null;

      if (!input) {
        return json({ error: "Missing simulation input" }, 400);
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

  await delay(1200);

  const running = generations.get(id);
  if (!running) return;

  const result = generateConceptGeometry(running.input);

  credits.reserved -= tokenCost;

  generations.set(id, {
    ...running,
    status: "completed",
    updatedAt: now(),
    result
  });
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

      if (remoteJobId) {
        await pollRemoteSimulation(id, remoteJobId, solverUrl);
        return;
      }

      throw new Error("Remote solver did not return a remoteJobId.");
    } catch (err) {
      const latest = simulations.get(id) ?? queued;

      simulations.set(id, {
        ...latest,
        status: "failed",
        errors: [...latest.errors, err instanceof Error ? err.message : String(err)],
        updatedAt: now()
      });

      return;
    }
  }

  try {
    await delay(800);

    const result = await runSimulation(queued.request);
    const report = buildSimulationReport(queued.request, result);

    simulations.set(id, {
      ...queued,
      status: result.status === "failed" ? "failed" : "completed",
      result,
      reportMarkdown: report.markdown,
      warnings: result.warnings,
      errors: result.errors,
      updatedAt: now()
    });
  } catch (err) {
    simulations.set(id, {
      ...queued,
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

    const response = await fetch(
      `${base}/simulation/result/${encodeURIComponent(remoteJobId)}`
    );

    const data = await readJson(response);

    if (!response.ok) {
      const latest = simulations.get(id);
      if (!latest) return;

      simulations.set(id, {
        ...latest,
        status: "failed",
        errors: [
          ...latest.errors,
          getRemoteError(data, `Remote solver result request failed: ${response.status}`)
        ],
        updatedAt: now()
      });

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

    if (remoteStatus === "completed" || remoteStatus === "failed") {
      return;
    }
  }

  const latest = simulations.get(id);
  if (!latest) return;

  simulations.set(id, {
    ...latest,
    status: latest.result ? "completed" : "failed",
    errors: latest.result
      ? latest.errors
      : [...latest.errors, "Remote solver timed out before returning a result."],
    updatedAt: now()
  });
}

function buildSimulationRequestFromInput(input: GenerationInput): SimulationRequest {
  const material = mapMaterial(input.material);

  const thicknessMm = Math.max(input.wallThicknessMm, 0.8);
  const zMm = Math.max(thicknessMm * 10, input.baseDiameterMm * 0.12, 5);
  const approximateVolumeMm3 =
    input.lengthMm * input.baseDiameterMm * thicknessMm * 0.42;

  return {
    id: `sim_request_${Date.now()}`,
    createdAtIso: now(),
    domain: "combined",

    geometry: {
      id: `geo_${Date.now()}`,
      name: input.componentName,
      primitive: "custom",
      boundingBoxMm: {
        x: input.lengthMm,
        y: input.baseDiameterMm,
        z: zMm
      },
      volumeMm3: approximateVolumeMm3,
      metadata: {
        componentFamily: input.componentFamily,
        targetMassKg: input.targetMassKg
      }
    },

    material,

    structural: {
      enabled: true,
      solver: "calculix",
      safetyFactorTarget: 2,
      maxAllowableDisplacementMm: 2.5,
      mesh: {
        targetElementSizeMm: 4,
        refinementLevel: 2,
        minElementSizeMm: 1.5,
        maxElementSizeMm: 8,
        boundaryLayer: false,
        qualityTarget: 0.72
      },
      loads: [
        {
          id: "primary_load",
          kind: "force",
          label: "Primary design load",
          magnitude: 850,
          unit: "N",
          direction: { x: 0, y: -1, z: 0 },
          targetRegion: "outer-mounting-face"
        }
      ],
      boundaryConditions: [
        {
          id: "fixed_base",
          label: "Fixed base",
          kind: "fixed",
          targetRegion: "base-mounting-face",
          lockedAxes: ["x", "y", "z"]
        }
      ]
    },

    thermal: {
      enabled: true,
      solver: "internal-fast-estimate",
      ambientTemperatureC: 22,
      buildPlateTemperatureC: 80,
      peakProcessTemperatureC: 420,
      coolingRateCPerSec: 35,
      distortionSensitivity: 0.3
    },

    manufacturability: {
      enabled: true,
      process: input.material === "PEEK-CF" ? "fdm" : "slm",
      maxOverhangDeg: 45,
      minWallThicknessMm: Math.max(0.8, thicknessMm * 0.35),
      minFeatureSizeMm: 0.8,
      preferredBuildAxis: "z",
      allowSupports: true,
      supportPenaltyWeight: 0.18,
      maxBuildVolumeMm: { x: 300, y: 300, z: 400 }
    },

    cfd: {
      enabled: true,
      solver: "internal-fast-estimate",
      fluid: "air",
      velocityMS: 40,
      angleOfAttackDeg: 0
    },

    tags: ["frontend", "simulation"],
    metadata: {
      source: "haf-api",
      componentFamily: input.componentFamily
    }
  };
}

function mapMaterial(material: string): MaterialSpec {
  if (material === "Ti-6Al-4V") return getMaterial("titanium_ti6al4v");
  if (material === "Inconel 718") return getMaterial("inconel_718");
  if (material === "AlSi10Mg") return getMaterial("aluminum_6061_t6");
  if (material === "PEEK-CF") return getMaterial("nylon");
  return getMaterial("aluminum_6061_t6");
}

function estimateTokenCost(input: GenerationInput): number {
  return Math.max(10, Math.floor(input.lengthMm / 180) + materialFactor(input.material) + 4);
}

function materialFactor(material: string) {
  if (material === "Ti-6Al-4V") return 3;
  if (material === "Inconel 718") return 4;
  return 1;
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
