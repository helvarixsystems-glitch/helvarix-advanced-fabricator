import type { GenerationInput, ValidationMessage } from "@haf/shared";

export function validateConcept(input: GenerationInput, estimatedMassKg: number): ValidationMessage[] {
  const messages: ValidationMessage[] = [];

  if (input.wallThicknessMm >= 2.5) {
    messages.push({
      severity: "success",
      title: "Wall Profile",
      text: "Nominal thickness remains within the current concept threshold."
    });
  } else {
    messages.push({
      severity: "warning",
      title: "Wall Profile",
      text: "Wall thickness is trending low for a first-pass additive concept and may need reinforcement."
    });
  }

  if (estimatedMassKg <= input.targetMassKg) {
    messages.push({
      severity: "success",
      title: "Mass Budget",
      text: "Estimated concept mass is currently within the provisional target envelope."
    });
  } else {
    messages.push({
      severity: "warning",
      title: "Mass Budget",
      text: "Current concept is slightly above the provisional target mass and may need a lighter internal rib strategy."
    });
  }

  if (input.material === "PEEK-CF") {
    messages.push({
      severity: "warning",
      title: "Material Fit",
      text: "PEEK-CF is suitable for lightweight prototyping paths, but thermal margins should be reviewed for high-load flight hardware."
    });
  } else {
    messages.push({
      severity: "success",
      title: "Material Fit",
      text: "Selected material aligns with an early-stage additive manufacturing concept workflow."
    });
  }

  messages.push({
    severity: "warning",
    title: "Export State",
    text: "Preview geometry is available, but production export generation has not been queued."
  });

  return messages;
}
