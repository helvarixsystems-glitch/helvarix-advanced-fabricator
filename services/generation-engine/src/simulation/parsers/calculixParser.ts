import { StructuralResult } from "../types";

export interface CalculixParsedResult {
  maxVonMisesStressPa?: number;
  maxDisplacementMm?: number;

  rawStressValues: number[];
  rawDisplacementValues: number[];

  warnings: string[];
  errors: string[];
}

/**
 * CalculiX parser.
 *
 * Handles simplified parsing for text-based solver outputs.
 *
 * Important:
 * CalculiX output formats vary depending on requested outputs:
 * - .dat
 * - .frd
 * - .sta
 *
 * This parser is intentionally tolerant.
 * It looks for stress/displacement-like numeric patterns and extracts
 * useful max values without crashing the pipeline.
 */
export function parseCalculixTextOutput(text: string): CalculixParsedResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const stressValues = extractStressValues(text);
  const displacementValues = extractDisplacementValues(text);

  if (stressValues.length === 0) {
    warnings.push("No stress values found in CalculiX output.");
  }

  if (displacementValues.length === 0) {
    warnings.push("No displacement values found in CalculiX output.");
  }

  return {
    maxVonMisesStressPa:
      stressValues.length > 0 ? Math.max(...stressValues.map(Math.abs)) : undefined,

    maxDisplacementMm:
      displacementValues.length > 0
        ? Math.max(...displacementValues.map(Math.abs))
        : undefined,

    rawStressValues: stressValues,
    rawDisplacementValues: displacementValues,

    warnings,
    errors,
  };
}

export function mergeCalculixParsedResultIntoStructuralResult(input: {
  fallback: StructuralResult;
  parsed: CalculixParsedResult;
  yieldStrengthPa: number;
  safetyFactorTarget: number;
}): StructuralResult {
  const stress =
    input.parsed.maxVonMisesStressPa ?? input.fallback.maxVonMisesStressPa;

  const displacement =
    input.parsed.maxDisplacementMm ?? input.fallback.maxDisplacementMm;

  const safetyFactor =
    stress > 0 ? input.yieldStrengthPa / stress : input.fallback.estimatedSafetyFactor;

  const warnings = [
    ...input.fallback.warnings,
    ...input.parsed.warnings,
  ];

  const pass = safetyFactor >= input.safetyFactorTarget;

  if (!pass) {
    warnings.push(
      `Parsed CalculiX safety factor ${formatNumber(
        safetyFactor
      )} is below target ${formatNumber(input.safetyFactorTarget)}.`
    );
  }

  return {
    status: input.parsed.errors.length > 0 ? "failed" : "completed",

    maxVonMisesStressPa: stress,
    maxDisplacementMm: displacement,
    estimatedSafetyFactor: safetyFactor,

    pass,
    warnings,
    solver: "calculix",
  };
}

function extractStressValues(text: string): number[] {
  const values: number[] = [];

  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const lower = line.toLowerCase();

    const looksLikeStress =
      lower.includes("mises") ||
      lower.includes("von") ||
      lower.includes("stress") ||
      lower.includes("sxx") ||
      lower.includes("syy") ||
      lower.includes("szz");

    if (!looksLikeStress) continue;

    values.push(...extractNumbers(line));
  }

  return sanitizeValues(values);
}

function extractDisplacementValues(text: string): number[] {
  const values: number[] = [];

  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const lower = line.toLowerCase();

    const looksLikeDisplacement =
      lower.includes("displacement") ||
      lower.includes("u1") ||
      lower.includes("u2") ||
      lower.includes("u3") ||
      lower.includes("ux") ||
      lower.includes("uy") ||
      lower.includes("uz");

    if (!looksLikeDisplacement) continue;

    values.push(...extractNumbers(line));
  }

  return sanitizeValues(values);
}

function extractNumbers(text: string): number[] {
  const matches = text.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g);

  if (!matches) return [];

  return matches
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function sanitizeValues(values: number[]): number[] {
  return values.filter((value) => {
    if (!Number.isFinite(value)) return false;
    if (Math.abs(value) < 1e-12) return false;
    return true;
  });
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(3);
}
