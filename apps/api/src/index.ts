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

const now = () => new Date().toISOString();

const projects = new Map<string, ProjectSummary>();
const generations = new Map<string, GenerationSummary>();
const exportsMap = new Map<string, ExportRecord>();

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
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "haf-api" });
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

function estimateTokenCost(input: GenerationInput): number {
  return Math.max(10, Math.floor(input.lengthMm / 180) + materialFactor(input.material) + 4);
}

function materialFactor(material: string) {
  if (material === "Ti-6Al-4V") return 3;
  if (material === "Inconel 718") return 4;
  return 1;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
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
