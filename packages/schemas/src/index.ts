import { z } from "zod";

export const projectSchema = z.object({
  name: z.string().min(2),
  partFamily: z.string().min(2)
});

export const generationInputSchema = z.object({
  componentFamily: z.string().min(2),
  componentName: z.string().min(2),
  lengthMm: z.coerce.number().positive(),
  baseDiameterMm: z.coerce.number().positive(),
  wallThicknessMm: z.coerce.number().positive(),
  material: z.string().min(2),
  targetMassKg: z.coerce.number().positive()
});

export const createGenerationSchema = z.object({
  projectId: z.string().min(2),
  input: generationInputSchema
});

export type ProjectInput = z.infer<typeof projectSchema>;
export type GenerationInputSchema = z.infer<typeof generationInputSchema>;
export type CreateGenerationInput = z.infer<typeof createGenerationSchema>;
