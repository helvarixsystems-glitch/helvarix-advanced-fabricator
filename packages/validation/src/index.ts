import type { GenerationInput, ValidationMessage } from "@haf/shared";

export function validateGenerationInput(input: GenerationInput): ValidationMessage[] {
  if (input.componentFamily === "bell-nozzle") {
    return validateBellNozzleInput(input);
  }

  return validateStructuralInput(input);
}

function validateStructuralInput(input: Exclude<GenerationInput, { componentFamily: "bell-nozzle" }>) {
  const { requirements } = input;
  const messages: ValidationMessage[] = [];

  const basePadRequirement =
    requirements.mounting.spacingMm + requirements.mounting.boltDiameterMm * 3.2;

  if (requirements.envelope.maxWidthMm < basePadRequirement) {
    messages.push({
      severity: "error",
      title: "Mounting Envelope Too Small",
      text: `The maximum width must be at least ${basePadRequirement.toFixed(
        1
      )} mm to fit the requested bolt pattern.`
    });
  }

  if (requirements.manufacturing.minWallThicknessMm < 0.8) {
    messages.push({
      severity: "warning",
      title: "Very Thin Wall",
      text: "Minimum wall thickness is unusually low for a load-bearing aerospace component."
    });
  }

  if (requirements.loadCase.forceN > 7500 && requirements.safetyFactor < 1.5) {
    messages.push({
      severity: "warning",
      title: "Low Safety Factor For High Load",
      text: "The load requirement is high, but the requested safety factor is below 1.5."
    });
  }

  if (
    requirements.manufacturing.process === "additive" &&
    !requirements.manufacturing.supportAllowed &&
    requirements.manufacturing.maxOverhangDeg < 45
  ) {
    messages.push({
      severity: "warning",
      title: "Strict Additive Constraint",
      text: "Support-free additive manufacturing with an overhang limit below 45 degrees may reject most candidate geometries."
    });
  }

  if (requirements.objectives.targetMassKg && requirements.objectives.targetMassKg < 0.15) {
    messages.push({
      severity: "warning",
      title: "Aggressive Mass Target",
      text: "The requested target mass is extremely low for a structural component."
    });
  }

  if (!messages.some((message) => message.severity === "error")) {
    messages.push({
      severity: "success",
      title: "Requirement Input Accepted",
      text: "Structural requirements passed first-pass validation and can be sent to the generator."
    });
  }

  return messages;
}

function validateBellNozzleInput(input: Extract<GenerationInput, { componentFamily: "bell-nozzle" }>) {
  const { requirements } = input;
  const messages: ValidationMessage[] = [];

  if (requirements.performance.targetThrustN > 0) {
    const chamberPressureBar = requirements.performance.chamberPressureBar ?? 20;
    const chamberPressurePa = chamberPressureBar * 100_000;
    const approximateThroatAreaM2 =
      requirements.performance.targetThrustN / Math.max(chamberPressurePa * 1.35, 1);
    const approximateThroatDiameterMm =
      Math.sqrt((4 * approximateThroatAreaM2) / Math.PI) * 1000;
    const approximateExitDiameterMm = approximateThroatDiameterMm * Math.sqrt(18);

    if (approximateExitDiameterMm > requirements.envelope.maxExitDiameterMm) {
      messages.push({
        severity: "warning",
        title: "Tight Nozzle Exit Envelope",
        text: `A first-pass estimate suggests an exit diameter near ${approximateExitDiameterMm.toFixed(
          1
        )} mm may be needed. Current maximum is ${requirements.envelope.maxExitDiameterMm} mm.`
      });
    }
  }

  if (
    requirements.performance.burnDurationSec > 90 &&
    requirements.thermal.coolingMode === "ablative"
  ) {
    messages.push({
      severity: "warning",
      title: "Long Ablative Burn",
      text: "The requested burn duration is long for an ablative nozzle. Regenerative or radiative cooling may produce better candidates."
    });
  }

  if (
    requirements.propellant.oxidizer === "LOX" &&
    requirements.propellant.fuel === "H2" &&
    requirements.thermal.coolingMode !== "regenerative"
  ) {
    messages.push({
      severity: "warning",
      title: "Hydrogen Cooling Consideration",
      text: "LOX/H2 nozzles commonly benefit from regenerative cooling assumptions in higher-performance designs."
    });
  }

  if (requirements.manufacturing.minWallThicknessMm < 1.2) {
    messages.push({
      severity: "warning",
      title: "Thin Nozzle Wall",
      text: "Minimum wall thickness is very low for a thermally loaded nozzle wall."
    });
  }

  if (requirements.safetyFactor < 1.25) {
    messages.push({
      severity: "warning",
      title: "Low Safety Factor",
      text: "The requested safety factor is low for a thermally and pressure-loaded propulsion component."
    });
  }

  if (!messages.some((message) => message.severity === "error")) {
    messages.push({
      severity: "success",
      title: "Requirement Input Accepted",
      text: "Bell nozzle requirements passed first-pass validation and can be sent to the generator."
    });
  }

  return messages;
}
