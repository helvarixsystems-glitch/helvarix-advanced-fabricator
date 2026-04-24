import type { GenerationInput } from "@haf/shared";

export type ComponentRegistryItem = {
  key: GenerationInput["componentFamily"];
  label: string;
  description: string;
  defaultInput: GenerationInput;
};

export const componentRegistry: ComponentRegistryItem[] = [
  {
    key: "structural-bracket",
    label: "Structural Bracket",
    description:
      "Requirements-first aerospace bracket generated from load, vibration, envelope, and manufacturing constraints.",
    defaultInput: {
      componentFamily: "structural-bracket",
      requirements: {
        loadCase: {
          forceN: 2500,
          direction: "vertical",
          vibrationHz: 120
        },
        safetyFactor: 1.5,
        mounting: {
          boltCount: 4,
          boltDiameterMm: 6,
          spacingMm: 48
        },
        envelope: {
          maxWidthMm: 160,
          maxHeightMm: 120,
          maxDepthMm: 90
        },
        manufacturing: {
          process: "additive",
          minWallThicknessMm: 3,
          maxOverhangDeg: 45,
          supportAllowed: true
        },
        objectives: {
          targetMassKg: 0.85,
          priority: "balanced"
        }
      }
    }
  },
  {
    key: "nosecone",
    label: "Nosecone",
    description:
      "Legacy concept family retained for UI compatibility. Future resolver should derive geometry from aero, thermal, and mission constraints.",
    defaultInput: {
      componentFamily: "structural-bracket",
      requirements: {
        loadCase: {
          forceN: 2500,
          direction: "vertical",
          vibrationHz: 120
        },
        safetyFactor: 1.5,
        mounting: {
          boltCount: 4,
          boltDiameterMm: 6,
          spacingMm: 48
        },
        envelope: {
          maxWidthMm: 160,
          maxHeightMm: 120,
          maxDepthMm: 90
        },
        manufacturing: {
          process: "additive",
          minWallThicknessMm: 3,
          maxOverhangDeg: 45,
          supportAllowed: true
        },
        objectives: {
          targetMassKg: 0.85,
          priority: "balanced"
        }
      }
    }
  },
  {
    key: "shell",
    label: "Aerospace Shell",
    description:
      "Legacy concept family retained for UI compatibility. Future resolver should derive geometry from pressure, thermal, stiffness, and mass constraints.",
    defaultInput: {
      componentFamily: "structural-bracket",
      requirements: {
        loadCase: {
          forceN: 1800,
          direction: "multi-axis",
          vibrationHz: 90
        },
        safetyFactor: 1.7,
        mounting: {
          boltCount: 6,
          boltDiameterMm: 5,
          spacingMm: 42
        },
        envelope: {
          maxWidthMm: 180,
          maxHeightMm: 140,
          maxDepthMm: 80
        },
        manufacturing: {
          process: "additive",
          minWallThicknessMm: 2.8,
          maxOverhangDeg: 45,
          supportAllowed: true
        },
        objectives: {
          targetMassKg: 0.9,
          priority: "lightweight"
        }
      }
    }
  },
  {
    key: "rover-arm",
    label: "Rover Arm Segment",
    description:
      "Legacy concept family retained for UI compatibility. Future resolver should derive geometry from torque, reach, stiffness, and joint-interface constraints.",
    defaultInput: {
      componentFamily: "structural-bracket",
      requirements: {
        loadCase: {
          forceN: 1200,
          direction: "lateral",
          vibrationHz: 60
        },
        safetyFactor: 2,
        mounting: {
          boltCount: 4,
          boltDiameterMm: 5,
          spacingMm: 44
        },
        envelope: {
          maxWidthMm: 220,
          maxHeightMm: 80,
          maxDepthMm: 70
        },
        manufacturing: {
          process: "additive",
          minWallThicknessMm: 3,
          maxOverhangDeg: 50,
          supportAllowed: true
        },
        objectives: {
          targetMassKg: 0.75,
          priority: "stiffness"
        }
      }
    }
  },
  {
    key: "grid-fin",
    label: "Grid Fin",
    description:
      "Legacy concept family retained for UI compatibility. Future resolver should derive geometry from aerodynamic load, thermal environment, hinge constraints, and manufacturability.",
    defaultInput: {
      componentFamily: "structural-bracket",
      requirements: {
        loadCase: {
          forceN: 3200,
          direction: "multi-axis",
          vibrationHz: 160
        },
        safetyFactor: 1.8,
        mounting: {
          boltCount: 6,
          boltDiameterMm: 6,
          spacingMm: 52
        },
        envelope: {
          maxWidthMm: 190,
          maxHeightMm: 150,
          maxDepthMm: 60
        },
        manufacturing: {
          process: "additive",
          minWallThicknessMm: 3.2,
          maxOverhangDeg: 45,
          supportAllowed: true
        },
        objectives: {
          targetMassKg: 1.1,
          priority: "balanced"
        }
      }
    }
  }
];
