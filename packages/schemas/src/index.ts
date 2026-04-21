import { z } from "zod";

export const projectSchema = z.object({
  name: z.string().min(2),
  partFamily: z.string().min(2)
});

export const noseconeSchema = z.object({
  name: z.string().min(2),
  lengthMm: z.number().positive(),
  baseDiameterMm: z.number().positive(),
  wallThicknessMm: z.number().positive(),
  material: z.string().min(2),
  targetMassKg: z.number().positive()
});

export type ProjectInput = z.infer<typeof projectSchema>;
export type NoseconeInput = z.infer<typeof noseconeSchema>;
