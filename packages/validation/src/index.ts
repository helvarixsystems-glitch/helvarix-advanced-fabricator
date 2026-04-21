export function getMockValidationMessages() {
  return [
    {
      severity: "success",
      title: "Wall Profile",
      text: "Nominal thickness remains within the current concept threshold."
    },
    {
      severity: "warning",
      title: "Mass Budget",
      text: "Current concept is slightly above the provisional target mass and may need a lighter internal rib strategy."
    },
    {
      severity: "warning",
      title: "Export State",
      text: "Preview geometry is available, but production export generation has not been queued."
    }
  ] as const;
}
