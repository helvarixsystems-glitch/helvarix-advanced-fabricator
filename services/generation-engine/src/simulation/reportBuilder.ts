import {
  SimulationRequest,
  SimulationResult,
  SimulationArtifact,
} from "./types";

export interface SimulationReport {
  id: string;
  title: string;
  createdAtIso: string;

  markdown: string;
  artifact: SimulationArtifact;
}

export function buildSimulationReport(
  request: SimulationRequest,
  result: SimulationResult
): SimulationReport {
  const title = `Simulation Report - ${request.geometry.name}`;

  const markdown = [
    `# ${title}`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    ``,
    result.summary,
    ``,
    `## Overall Score`,
    ``,
    `| Category | Score |`,
    `|---|---:|`,
    `| Structural | ${result.score.structural}/100 |`,
    `| Thermal | ${result.score.thermal}/100 |`,
    `| Manufacturability | ${result.score.manufacturability}/100 |`,
    `| CFD | ${result.score.cfd}/100 |`,
    `| Mass | ${result.score.mass}/100 |`,
    `| **Total** | **${result.score.total}/100** |`,
    ``,
    `## Geometry`,
    ``,
    `| Field | Value |`,
    `|---|---:|`,
    `| Name | ${request.geometry.name} |`,
    `| Primitive | ${request.geometry.primitive ?? "custom"} |`,
    `| X | ${request.geometry.boundingBoxMm.x.toFixed(2)} mm |`,
    `| Y | ${request.geometry.boundingBoxMm.y.toFixed(2)} mm |`,
    `| Z | ${request.geometry.boundingBoxMm.z.toFixed(2)} mm |`,
    `| Volume | ${
      request.geometry.volumeMm3
        ? `${request.geometry.volumeMm3.toFixed(2)} mm³`
        : "Unknown"
    } |`,
    ``,
    `## Material`,
    ``,
    `| Property | Value |`,
    `|---|---:|`,
    `| Material | ${request.material.name} |`,
    `| Density | ${request.material.densityKgM3} kg/m³ |`,
    `| Young's Modulus | ${formatScientific(
      request.material.youngsModulusPa
    )} Pa |`,
    `| Yield Strength | ${formatScientific(
      request.material.yieldStrengthPa
    )} Pa |`,
    `| Poisson Ratio | ${request.material.poissonRatio} |`,
    ``,
    buildStructuralSection(result),
    ``,
    buildThermalSection(result),
    ``,
    buildManufacturabilitySection(result),
    ``,
    buildCfdSection(result),
    ``,
    buildWarningsSection(result),
    ``,
    buildErrorsSection(result),
    ``,
  ].join("\n");

  return {
    id: `report_${safeId()}`,
    title,
    createdAtIso: new Date().toISOString(),
    markdown,
    artifact: {
      id: `artifact_report_${safeId()}`,
      kind: "report",
      label: title,
      inlineText: markdown,
      metadata: {
        requestId: request.id,
        resultId: result.id,
      },
    },
  };
}

function buildStructuralSection(result: SimulationResult): string {
  if (!result.structural) {
    return [
      `## Structural Result`,
      ``,
      `Structural analysis was not enabled.`,
    ].join("\n");
  }

  const s = result.structural;

  return [
    `## Structural Result`,
    ``,
    `| Metric | Value |`,
    `|---|---:|`,
    `| Status | ${s.status} |`,
    `| Pass | ${s.pass ? "Yes" : "No"} |`,
    `| Solver | ${s.solver} |`,
    `| Max Von Mises Stress | ${formatScientific(s.maxVonMisesStressPa)} Pa |`,
    `| Max Displacement | ${s.maxDisplacementMm.toFixed(4)} mm |`,
    `| Estimated Safety Factor | ${formatNumber(s.estimatedSafetyFactor)} |`,
  ].join("\n");
}

function buildThermalSection(result: SimulationResult): string {
  if (!result.thermal) {
    return [
      `## Thermal Result`,
      ``,
      `Thermal analysis was not enabled.`,
    ].join("\n");
  }

  const t = result.thermal;

  return [
    `## Thermal Result`,
    ``,
    `| Metric | Value |`,
    `|---|---:|`,
    `| Status | ${t.status} |`,
    `| Pass | ${t.pass ? "Yes" : "No"} |`,
    `| Solver | ${t.solver} |`,
    `| Estimated Max Temperature | ${t.estimatedMaxTemperatureC.toFixed(2)} °C |`,
    `| Estimated Thermal Expansion | ${t.estimatedThermalExpansionMm.toFixed(
      4
    )} mm |`,
    `| Estimated Distortion | ${t.estimatedDistortionMm.toFixed(4)} mm |`,
  ].join("\n");
}

function buildManufacturabilitySection(result: SimulationResult): string {
  if (!result.manufacturability) {
    return [
      `## Manufacturability Result`,
      ``,
      `Manufacturability analysis was not enabled.`,
    ].join("\n");
  }

  const m = result.manufacturability;

  return [
    `## Manufacturability Result`,
    ``,
    `| Metric | Value |`,
    `|---|---:|`,
    `| Status | ${m.status} |`,
    `| Pass | ${m.pass ? "Yes" : "No"} |`,
    `| Overhang Pass | ${m.overhangPass ? "Yes" : "No"} |`,
    `| Wall Thickness Pass | ${m.wallThicknessPass ? "Yes" : "No"} |`,
    `| Build Volume Pass | ${m.buildVolumePass ? "Yes" : "No"} |`,
    `| Support Required | ${m.supportRequired ? "Yes" : "No"} |`,
    `| Estimated Support Volume | ${m.estimatedSupportVolumeMm3.toFixed(
      2
    )} mm³ |`,
    `| Manufacturability Score | ${m.manufacturabilityScore.toFixed(2)}/100 |`,
  ].join("\n");
}

function buildCfdSection(result: SimulationResult): string {
  if (!result.cfd) {
    return [
      `## CFD Result`,
      ``,
      `CFD analysis was not enabled.`,
    ].join("\n");
  }

  const c = result.cfd;

  return [
    `## CFD Result`,
    ``,
    `| Metric | Value |`,
    `|---|---:|`,
    `| Status | ${c.status} |`,
    `| Pass | ${c.pass ? "Yes" : "No"} |`,
    `| Solver | ${c.solver} |`,
    `| Estimated Drag | ${c.estimatedDragN.toFixed(4)} N |`,
    `| Estimated Lift | ${c.estimatedLiftN.toFixed(4)} N |`,
    `| Estimated Dynamic Pressure | ${c.estimatedPressurePa.toFixed(4)} Pa |`,
    `| Reynolds Number | ${
      c.reynoldsNumber ? formatScientific(c.reynoldsNumber) : "Unknown"
    } |`,
  ].join("\n");
}

function buildWarningsSection(result: SimulationResult): string {
  if (result.warnings.length === 0) {
    return [`## Warnings`, ``, `No warnings.`].join("\n");
  }

  return [
    `## Warnings`,
    ``,
    ...result.warnings.map((warning) => `- ${warning}`),
  ].join("\n");
}

function buildErrorsSection(result: SimulationResult): string {
  if (result.errors.length === 0) {
    return [`## Errors`, ``, `No errors.`].join("\n");
  }

  return [
    `## Errors`,
    ``,
    ...result.errors.map((error) => `- ${error}`),
  ].join("\n");
}

function formatScientific(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toExponential(3);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  return value.toFixed(3);
}

function safeId(): string {
  return Math.random().toString(36).slice(2, 10);
}
