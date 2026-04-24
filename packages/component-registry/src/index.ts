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
      "Generates a load-bearing bracket from force, vibration, envelope, mounting, safety factor, and manufacturing constraints.",
    defaultInput: {
      componentFamily: "structural-bracket",
      requirements: {
        componentName: "HAF-Structural-Bracket-01",
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
    key: "bell-nozzle",
    label: "Bell Nozzle",
    description:
      "Derives a first-pass nozzle contour from thrust, burn duration, chamber pressure, propellant pair, cooling mode, envelope, and manufacturability constraints.",
    defaultInput: {
      componentFamily: "bell-nozzle",
      requirements: {
        componentName: "HAF-Bell-Nozzle-01",
        performance: {
          targetThrustN: 2000,
          burnDurationSec: 45,
          chamberPressureBar: 20,
          ambientPressurePa: 101325
        },
        propellant: {
          oxidizer: "LOX",
          fuel: "RP1",
          mixtureRatio: 2.6
        },
        envelope: {
          maxLengthMm: 520,
          maxExitDiameterMm: 220
        },
        thermal: {
          coolingMode: "ablative",
          maxWallTemperatureC: 700
        },
        manufacturing: {
          process: "additive",
          minWallThicknessMm: 2.5,
          supportAllowed: true
        },
        objectives: {
          priority: "balanced",
          targetMassKg: 3.5
        },
        safetyFactor: 1.5
      }
    }
  },
  {
    key: "pressure-vessel",
    label: "Pressure Vessel Mount",
    description:
      "Uses the structural resolver for now. Future pass should derive wall, dome, weld/interface, pressure, and burst-margin geometry.",
    defaultInput: {
      componentFamily: "pressure-vessel",
      requirements: {
        componentName: "HAF-Pressure-Vessel-Mount-01",
        loadCase: {
          forceN: 3200,
          direction: "multi-axis",
          vibrationHz: 140
        },
        safetyFactor: 2,
        mounting: {
          boltCount: 6,
          boltDiameterMm: 6,
          spacingMm: 52
        },
        envelope: {
          maxWidthMm: 190,
          maxHeightMm: 150,
          maxDepthMm: 100
        },
        manufacturing: {
          process: "additive",
          minWallThicknessMm: 3.2,
          maxOverhangDeg: 45,
          supportAllowed: true
        },
        objectives: {
          targetMassKg: 1.15,
          priority: "stiffness"
        }
      }
    }
  },
  {
    key: "rover-arm",
    label: "Rover Arm Segment",
    description:
      "Uses the structural resolver for now. Future pass should derive joint geometry from torque, reach, stiffness, and interface loads.",
    defaultInput: {
      componentFamily: "rover-arm",
      requirements: {
        componentName: "HAF-Rover-Arm-Segment-01",
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
      "Uses the structural resolver for now. Future pass should derive lattice, hinge, aero-load, and thermal geometry.",
    defaultInput: {
      componentFamily: "grid-fin",
      requirements: {
        componentName: "HAF-Grid-Fin-01",
        loadCase: {
          forceN: 4800,
          direction: "multi-axis",
          vibrationHz: 180
        },
        safetyFactor: 1.8,
        mounting: {
          boltCount: 6,
          boltDiameterMm: 6,
          spacingMm: 54
        },
        envelope: {
          maxWidthMm: 210,
          maxHeightMm: 170,
          maxDepthMm: 70
        },
        manufacturing: {
          process: "additive",
          minWallThicknessMm: 3.2,
          maxOverhangDeg: 45,
          supportAllowed: true
        },
        objectives: {
          targetMassKg: 1.25,
          priority: "balanced"
        }
      }
    }
  }
];
