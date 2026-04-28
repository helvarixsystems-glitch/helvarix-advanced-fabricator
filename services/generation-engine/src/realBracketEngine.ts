// realBracketEngine.ts

type BracketRequest = {
  boltCount: number;
  load: number; // Newtons
  width: number;
  height: number;
  thickness: number;
};

type Candidate = {
  geometry: any;
  mass: number;
  stress: number;
  valid: boolean;
  reason?: string;
};

const MATERIAL_STRENGTH = 250e6; // Pa (Aluminum approx)
const DENSITY = 2700; // kg/m^3

export function generateBracket(req: BracketRequest) {
  const candidates: Candidate[] = [];

  // Deterministic variations
  const thicknessOptions = [
    req.thickness,
    req.thickness * 1.2,
    req.thickness * 0.8
  ];

  for (const t of thicknessOptions) {
    const candidate = buildCandidate(req, t);

    // Constraint filtering FIRST
    const constraintResult = checkConstraints(candidate, req);

    if (!constraintResult.valid) {
      candidates.push({
        ...candidate,
        valid: false,
        reason: constraintResult.reason
      });
      continue;
    }

    // Simulation
    const sim = runSimulation(candidate, req);
    candidate.stress = sim.stress;

    // Check structural validity
    if (sim.stress > MATERIAL_STRENGTH) {
      candidate.valid = false;
      candidate.reason = "FAIL_STRESS";
    } else {
      candidate.valid = true;
    }

    candidates.push(candidate);
  }

  // Select best valid candidate
  const validCandidates = candidates.filter((c) => c.valid);

  if (validCandidates.length === 0) {
    return {
      status: "FAILED",
      candidates
    };
  }

  const best = validCandidates.sort((a, b) => score(a) - score(b))[0];

  return {
    status: "SUCCESS",
    best,
    candidates
  };
}

// ----------------------------
// Core Functions
// ----------------------------

function buildCandidate(req: BracketRequest, thickness: number): Candidate {
  const volume = req.width * req.height * thickness * 0.4; // simple reduction factor
  const mass = volume * DENSITY;

  const geometry = {
    type: "bracket",
    boltCount: req.boltCount,
    width: req.width,
    height: req.height,
    thickness
  };

  return {
    geometry,
    mass,
    stress: 0,
    valid: true
  };
}

function checkConstraints(candidate: Candidate, req: BracketRequest) {
  if (req.boltCount < 2 || req.boltCount > 6) {
    return {
      valid: false,
      reason: "INVALID_BOLT_COUNT"
    };
  }

  if (candidate.geometry.thickness < 0.002) {
    return {
      valid: false,
      reason: "TOO_THIN"
    };
  }

  if (req.width < 0.02 || req.height < 0.02) {
    return {
      valid: false,
      reason: "TOO_SMALL"
    };
  }

  return {
    valid: true
  };
}

function runSimulation(candidate: Candidate, req: BracketRequest) {
  // Extremely simplified stress model
  const area = candidate.geometry.width * candidate.geometry.thickness;
  const stress = req.load / area;

  return {
    stress
  };
}

function score(candidate: Candidate) {
  // Lower is better
  return candidate.mass + candidate.stress * 1e-6;
}
