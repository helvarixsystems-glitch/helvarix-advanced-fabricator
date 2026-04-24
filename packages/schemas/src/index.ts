import { z } from "zod";

const familySchema = z.enum([
  "structural-bracket",
  "nosecone",
  "shell",
  "rover-arm",
  "grid-fin"
]);

const loadDirectionSchema = z.enum(["vertical", "lateral", "multi-axis"]);
const manufacturingProcessSchema = z.enum(["additive", "machined"]);
const optimizationPrioritySchema = z.enum(["lightweight", "stiffness", "balanced"]);

const structuralBracketRequirementsSchema = z.object({
  loadCase: z.object({
    forceN: z.coerce.number().positive(),
    direction: loadDirectionSchema,
    vibrationHz: z.coerce.number().positive().optional()
  }),

  safetyFactor: z.coerce.number().min(1).max(5),

  mounting: z.object({
    boltCount: z.coerce.number().int().min(2).max(12),
    boltDiameterMm: z.coerce.number().positive(),
    spacingMm: z.coerce.number().positive()
  }),

  envelope: z.object({
    maxWidthMm: z.coerce.number().positive(),
    maxHeightMm: z.coerce.number().positive(),
    maxDepthMm: z.coerce.number().positive()
  }),

  manufacturing: z.object({
    process: manufacturingProcessSchema,
    minWallThicknessMm: z.coerce.number().positive(),
    maxOverhangDeg: z.coerce.number().min(15).max(75),
    supportAllowed: z.boolean()
  }),

  objectives: z.object({
    targetMassKg: z.coerce.number().positive().optional(),
    priority: optimizationPrioritySchema
  })
});

export const projectSchema = z.object({
  name: z.string().min(2),
  componentFamily: familySchema,
  workspaceLabel: z.string().min(2).default("Fabrication Bay 01")
});

export const generationInputSchema = z.object({
  componentFamily: familySchema,
  requirements: structuralBracketRequirementsSchema
});

export const createGenerationSchema = z.object({
  projectId: z.string().min(2),
  parentGenerationId: z.string().optional().nullable(),
  input: generationInputSchema
});

export const createIterationSchema = z.object({
  projectId: z.string().min(2),
  parentGenerationId: z.string().min(2),
  input: generationInputSchema
});

export const queueExportSchema = z.object({
  generationId: z.string().min(2),
  format: z.enum(["stl", "step", "json", "package"]).default("stl")
});

export type ProjectInput = z.infer<typeof projectSchema>;
export type GenerationInputSchema = z.infer<typeof generationInputSchema>;
export type CreateGenerationInput = z.infer<typeof createGenerationSchema>;
export type CreateIterationInput = z.infer<typeof createIterationSchema>;
export type QueueExportInput = z.infer<typeof queueExportSchema>;
