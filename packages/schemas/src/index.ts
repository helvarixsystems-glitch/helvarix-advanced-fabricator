import { z } from "zod";

const familySchema = z.enum(["nosecone", "shell", "rover-arm", "grid-fin"]);

export const projectSchema = z.object({
  name: z.string().min(2),
  componentFamily: familySchema,
  workspaceLabel: z.string().min(2).default("Fabrication Bay 01")
});

export const generationInputSchema = z.object({
  componentFamily: familySchema,
  componentName: z.string().min(2),
  lengthMm: z.coerce.number().positive(),
  baseDiameterMm: z.coerce.number().positive(),
  wallThicknessMm: z.coerce.number().positive(),
  material: z.string().min(2),
  targetMassKg: z.coerce.number().positive()
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
  format: z.enum(["stl", "step", "json"]).default("stl")
});

export type ProjectInput = z.infer<typeof projectSchema>;
export type GenerationInputSchema = z.infer<typeof generationInputSchema>;
export type CreateGenerationInput = z.infer<typeof createGenerationSchema>;
export type CreateIterationInput = z.infer<typeof createIterationSchema>;
export type QueueExportInput = z.infer<typeof queueExportSchema>;
