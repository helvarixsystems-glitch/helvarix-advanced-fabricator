import { MaterialSpec } from "./types";

/**
 * Baseline engineering materials.
 * These are simplified but realistic enough for early-stage simulation.
 */

export const MATERIAL_LIBRARY: Record<string, MaterialSpec> = {
  aluminum_6061_t6: {
    id: "aluminum_6061_t6",
    name: "Aluminum 6061-T6",

    densityKgM3: 2700,
    youngsModulusPa: 69e9,
    poissonRatio: 0.33,
    yieldStrengthPa: 276e6,
    ultimateStrengthPa: 310e6,

    thermalConductivityWMK: 167,
    thermalExpansion1K: 23e-6,
    specificHeatJkgK: 896,

    printable: true,
  },

  titanium_ti6al4v: {
    id: "titanium_ti6al4v",
    name: "Titanium Ti-6Al-4V",

    densityKgM3: 4430,
    youngsModulusPa: 113e9,
    poissonRatio: 0.34,
    yieldStrengthPa: 880e6,
    ultimateStrengthPa: 950e6,

    thermalConductivityWMK: 6.7,
    thermalExpansion1K: 9e-6,
    specificHeatJkgK: 560,

    printable: true,
  },

  stainless_steel_316l: {
    id: "stainless_steel_316l",
    name: "Stainless Steel 316L",

    densityKgM3: 8000,
    youngsModulusPa: 193e9,
    poissonRatio: 0.30,
    yieldStrengthPa: 290e6,
    ultimateStrengthPa: 580e6,

    thermalConductivityWMK: 16,
    thermalExpansion1K: 16e-6,
    specificHeatJkgK: 500,

    printable: true,
  },

  inconel_718: {
    id: "inconel_718",
    name: "Inconel 718",

    densityKgM3: 8190,
    youngsModulusPa: 200e9,
    poissonRatio: 0.29,
    yieldStrengthPa: 1030e6,
    ultimateStrengthPa: 1240e6,

    thermalConductivityWMK: 11.4,
    thermalExpansion1K: 13e-6,
    specificHeatJkgK: 435,

    printable: true,
  },

  abs: {
    id: "abs",
    name: "ABS Plastic",

    densityKgM3: 1040,
    youngsModulusPa: 2.1e9,
    poissonRatio: 0.35,
    yieldStrengthPa: 40e6,

    thermalConductivityWMK: 0.18,
    thermalExpansion1K: 90e-6,
    specificHeatJkgK: 1300,

    printable: true,
  },

  nylon: {
    id: "nylon",
    name: "Nylon (PA12)",

    densityKgM3: 1020,
    youngsModulusPa: 1.7e9,
    poissonRatio: 0.39,
    yieldStrengthPa: 45e6,

    thermalConductivityWMK: 0.25,
    thermalExpansion1K: 80e-6,
    specificHeatJkgK: 1700,

    printable: true,
  },

  carbon_steel: {
    id: "carbon_steel",
    name: "Carbon Steel",

    densityKgM3: 7850,
    youngsModulusPa: 200e9,
    poissonRatio: 0.29,
    yieldStrengthPa: 250e6,
    ultimateStrengthPa: 460e6,

    thermalConductivityWMK: 50,
    thermalExpansion1K: 12e-6,
    specificHeatJkgK: 490,

    printable: false,
  },
};

/**
 * Fetch material safely
 */
export function getMaterial(id: string): MaterialSpec {
  const mat = MATERIAL_LIBRARY[id];

  if (!mat) {
    throw new Error(`Material not found: ${id}`);
  }

  return mat;
}

/**
 * Lightweight helper for simulation weighting
 */
export function estimateMassFromVolume(
  volumeMm3: number,
  material: MaterialSpec
): number {
  const volumeM3 = volumeMm3 / 1e9;
  return volumeM3 * material.densityKgM3;
}

/**
 * Normalize material strength into a scoring factor
 */
export function materialStrengthFactor(material: MaterialSpec): number {
  // normalized roughly against 1 GPa
  return material.yieldStrengthPa / 1e9;
}

/**
 * Thermal expansion estimate (very simplified)
 */
export function estimateThermalExpansion(
  lengthMm: number,
  deltaTempC: number,
  material: MaterialSpec
): number {
  if (!material.thermalExpansion1K) return 0;

  return lengthMm * material.thermalExpansion1K * deltaTempC;
}
