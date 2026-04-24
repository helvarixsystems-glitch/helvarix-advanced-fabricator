import { z } from "zod";

// ==============================
// ENUMS
// ==============================

const componentFamilySchema = z.enum([
  "structural-bracket",
  "bell-nozzle",
  "pressure-vessel",
  "rover-arm",
  "grid-fin"
]);

const loadDirectionSchema = z.enum(["vertical", "lateral", "multi-axis"]);
const manufacturingProcessSchema = z.enum(["additive", "machined"]);
const optimizationPrioritySchema = z.enum(["lightweight", "stiffness", "balanced"]);

const oxidizerSchema = z.enum(["LOX", "N2O", "H2O2"]);
const fuelSchema = z.enum(["RP1", "CH4", "H2", "HTPB"]);
const coolingModeSchema = z.enum(["ablative", "regenerative", "radiative"]);

// ==============================
// STRUCTURAL BRACKET
// ==============================

export const structuralBracketRequirementsSchema = z.object({
  componentName: z.string().min(2),

  loadCase: z.object({
    forceN: z.number().positive(),
    direction: loadDirectionSchema,
    vibrationHz: z.number().positive().optional()
  }),

  safetyFactor: z.number().min(1).max(5),

  mounting: z.object({
    boltCount: z.number().int().min(2).max(16),
    boltDiameterMm: z.number().positive(),
    spacingMm: z.number().positive()
  }),

  envelope: z.object({
    maxWidthMm: z.number().positive(),
    maxHeightMm: z.number().positive(),
    maxDepthMm: z.number().positive()
  }),

  manufacturing: z.object({
    process: manufacturingProcessSchema,
    minWallThicknessMm: z.number().positive(),
    maxOverhangDeg: z.number().min(10).max(80),
    supportAllowed: z.boolean()
  }),

  objectives: z.object({
    targetMassKg: z.number().positive().optional(),
    priority: optimizationPrioritySchema
  })
});

// ==============================
// BELL NOZZLE
// ==============================

export const bellNozzleRequirementsSchema = z.object({
  componentName: z.string().min(2),

  performance: z.object({
    targetThrustN: z.number().positive(),
    burnDurationSec: z.number().positive(),
    chamberPressureBar: z.number().positive().optional(),
    ambientPressurePa: z.number().positive()
  }),

  propellant: z.object({
    oxidizer: oxidizerSchema,
    fuel: fuelSchema,
    mixtureRatio: z.number().positive().optional()
  }),

  envelope: z.object({
    maxLengthMm: z.number().positive(),
    maxExitDiameterMm: z.number().positive()
  }),

  thermal: z.object({
    coolingMode: coolingModeSchema,
    maxWallTemperatureC: z.number().positive().optional()
  }),

  manufacturing: z.object({
    process: manufacturingProcessSchema,
    minWallThicknessMm: z.number().positive(),
    supportAllowed: z.boolean()
  }),

  objectives: z.object({
    priority: z.enum(["efficiency", "compactness", "thermal-margin", "balanced"]),
    targetMassKg: z.number().positive().optional()
  }),

  safetyFactor: z.number().min(1).max(5)
});

// ==============================
// GENERATION INPUT (DISCRIMINATED)
// ==============================

export const generationInputSchema = z.discriminatedUnion("componentFamily", [
  z.object({
    componentFamily: z.literal("structural-bracket"),
    requirements: structuralBracketRequirementsSchema
  }),
  z.object({
    componentFamily: z.literal("bell-nozzle"),
    requirements: bellNozzleRequirementsSchema
  }),
  z.object({
    componentFamily: z.enum(["pressure-vessel", "rover-arm", "grid-fin"]),
    requirements: structuralBracketRequirementsSchema
  })
]);

// ==============================
// API WRAPPERS
// ==============================

export const createGenerationSchema = z.object({
  projectId: z.string().min(2),
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

// ==============================
// TYPES
// ==============================

export type GenerationInputSchema = z.infer<typeof generationInputSchema>;
export type CreateGenerationInput = z.infer<typeof createGenerationSchema>;
export type CreateIterationInput = z.infer<typeof createIterationSchema>;
export type QueueExportInput = z.infer<typeof queueExportSchema>;
