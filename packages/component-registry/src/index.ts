export const componentRegistry = [
  {
    key: "nosecone",
    label: "Nosecone",
    baseTokenCost: 12,
    defaultInput: {
      componentFamily: "nosecone",
      componentName: "HAF-NC-01",
      lengthMm: 1200,
      baseDiameterMm: 320,
      wallThicknessMm: 3.4,
      material: "PEEK-CF",
      targetMassKg: 8.6
    }
  },
  {
    key: "shell",
    label: "Structural Shell",
    baseTokenCost: 14,
    defaultInput: {
      componentFamily: "shell",
      componentName: "HAF-SH-01",
      lengthMm: 950,
      baseDiameterMm: 400,
      wallThicknessMm: 4.2,
      material: "AlSi10Mg",
      targetMassKg: 12.5
    }
  },
  {
    key: "rover-arm",
    label: "Rover Arm",
    baseTokenCost: 18,
    defaultInput: {
      componentFamily: "rover-arm",
      componentName: "HAF-RA-01",
      lengthMm: 780,
      baseDiameterMm: 120,
      wallThicknessMm: 5,
      material: "Ti-6Al-4V",
      targetMassKg: 6.8
    }
  },
  {
    key: "grid-fin",
    label: "Grid Fin",
    baseTokenCost: 16,
    defaultInput: {
      componentFamily: "grid-fin",
      componentName: "HAF-GF-01",
      lengthMm: 620,
      baseDiameterMm: 280,
      wallThicknessMm: 4,
      material: "Inconel 718",
      targetMassKg: 9.4
    }
  }
] as const;
