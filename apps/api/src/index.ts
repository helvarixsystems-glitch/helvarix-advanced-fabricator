import { projectSchema } from "@haf/schemas";
import type { CreditBalance, GenerationSummary, ProjectSummary } from "@haf/shared";

const projects: ProjectSummary[] = [
  {
    id: "proj_0001",
    name: "Lunar Nosecone Study",
    partFamily: "nosecone",
    updatedAt: new Date().toISOString()
  }
];

const generations: GenerationSummary[] = [
  {
    id: "gen_0001",
    projectId: "proj_0001",
    componentName: "HAF-NC-01",
    status: "completed",
    tokenCost: 12,
    updatedAt: new Date().toISOString()
  }
];

const credits: CreditBalance = {
  available: 184,
  reserved: 12
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

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
      return json({ generations });
    }

    if (request.method === "GET" && url.pathname === "/credits/balance") {
      return json({ credits });
    }

    return json({ error: "Not found" }, 404);
  }
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*"
    }
  });
}
