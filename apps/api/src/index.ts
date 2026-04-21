import { createGenerationSchema, projectSchema } from "@haf/schemas";
import type {
  CreditBalance,
  GenerationInput,
  GenerationSummary,
  ProjectSummary
} from "@haf/shared";
import { generateConceptGeometry } from "../../../services/generation-engine/src/index";

const projects: ProjectSummary[] = [
  {
    id: "proj_0001",
    name: "Lunar Nosecone Study",
    partFamily: "nosecone",
    updatedAt: new Date().toISOString()
  }
];

const generations = new Map<string, GenerationSummary>();
const credits: CreditBalance = {
  available: 184,
  reserved: 0
};

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
  projectId: "proj_0001",
  componentName: "HAF-NC-01",
  status: "completed",
  tokenCost: 12,
  updatedAt: new Date().toISOString(),
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

    if (request.method === "GET" && url.pathname === "/projects") {
      return json({ projects });
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
        partFamily: parsed.data.partFamily,
        updatedAt: new Date().toISOString()
      };

      projects.unshift(project);
      return json({ project }, 201);
    }

    if (request.method === "GET" && url.pathname === "/generations") {
      return json({
        generations: Array.from(generations.values()).sort((a, b) =>
          a.updatedAt < b.updatedAt ? 1 : -1
        )
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/generations/")) {
      const id = url.pathname.split("/").pop()!;
      const generation = generations.get(id);

      if (!generation) {
        return json({ error: "Generation not found" }, 404);
      }

      return json({ generation });
    }

    if (request.method === "POST" && url.pathname === "/generations") {
      const body = await request.json();
      const parsed = createGenerationSchema.safeParse(body);

      if (!parsed.success) {
        return json({ error: parsed.error.flatten() }, 400);
      }

      const { projectId, input } = parsed.data;
      const tokenCost = Math.max(10, Math.floor(input.lengthMm / 150) + 4);

      if (credits.available < tokenCost) {
        return json({ error: "Insufficient credits" }, 400);
      }

      credits.available -= tokenCost;
      credits.reserved += tokenCost;

      const id = `gen_${Date.now()}`;
      const generation: GenerationSummary = {
        id,
        projectId,
        componentName: input.componentName,
        status: "queued",
        tokenCost,
        updatedAt: new Date().toISOString(),
        input
      };

      generations.set(id, generation);

      ctx.waitUntil(runGenerationJob(id, tokenCost));

      return json({ generation }, 201);
    }

    if (request.method === "GET" && url.pathname === "/credits/balance") {
      return json({ credits });
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
    updatedAt: new Date().toISOString()
  });

  await delay(1500);

  const running = generations.get(id);
  if (!running) return;

  const result = generateConceptGeometry(running.input);

  credits.reserved -= tokenCost;

  generations.set(id, {
    ...running,
    status: "completed",
    updatedAt: new Date().toISOString(),
    result
  });
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
