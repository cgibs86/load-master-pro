/**
 * Simplified residential HVAC load calculation engine.
 *
 * This follows the general structure of an ACCA Manual J load calculation but
 * is intentionally simplified for estimating purposes. It is suitable for
 * sizing guidance and education — not a substitute for a full Manual J report
 * for permit or equipment-selection sign-off.
 *
 * All loads are expressed in BTU/h. Areas are in square feet, temperatures in
 * degrees Fahrenheit, and R-values in (h·ft²·°F)/BTU.
 */

export interface LoadInputs {
  // Design conditions (°F)
  indoorWinter: number; // heating setpoint
  indoorSummer: number; // cooling setpoint
  outdoorWinter: number; // 99% winter design temperature
  outdoorSummer: number; // 1% summer design temperature

  // Geometry
  floorArea: number; // conditioned floor area (ft²)
  ceilingHeight: number; // average ceiling height (ft)
  wallArea: number; // gross above-grade exterior wall area (ft²)
  windowArea: number; // total glazing area (ft²)
  doorArea: number; // total opaque exterior door area (ft²)

  // Envelope insulation
  wallR: number; // effective wall R-value
  ceilingR: number; // ceiling / roof R-value
  floorR: number; // floor R-value (over unconditioned space)
  doorR: number; // door R-value
  windowU: number; // window U-factor (BTU/h·ft²·°F)
  windowSHGC: number; // solar heat gain coefficient (0–1)

  // Air leakage
  ach: number; // air changes per hour at natural conditions

  // Internal gains (cooling only)
  occupants: number;
  applianceWatts: number; // continuous appliance + lighting load (W)

  // Peak solar gain per ft² of glazing (BTU/h·ft²). Depends on orientation,
  // shading, and latitude. Typical effective average ≈ 150–250.
  solarGainPerSqft: number;

  // Outdoor-to-indoor moisture difference, in grains of water per lb of dry
  // air, used for the latent infiltration load. Humid climates ≈ 30–50.
  grainsDifference: number;
}

export interface LoadBreakdown {
  walls: number;
  windows: number;
  doors: number;
  ceiling: number;
  floor: number;
  infiltration: number;
  solar?: number;
  occupants?: number;
  appliances?: number;
}

export interface LoadResults {
  heating: {
    total: number;
    breakdown: LoadBreakdown;
  };
  cooling: {
    sensible: number;
    latent: number;
    total: number;
    tons: number;
    breakdown: LoadBreakdown & { latentInfiltration: number; latentOccupants: number };
  };
}

/** Conductance (U) from an R-value, guarding against divide-by-zero. */
export function uFromR(r: number): number {
  return r > 0 ? 1 / r : 0;
}

/** Net opaque wall area after subtracting glazing and doors. */
export function netWallArea(input: LoadInputs): number {
  return Math.max(0, input.wallArea - input.windowArea - input.doorArea);
}

/** Building volume used for infiltration airflow. */
export function buildingVolume(input: LoadInputs): number {
  return input.floorArea * input.ceilingHeight;
}

/** Natural infiltration airflow in CFM from ACH and volume. */
export function infiltrationCFM(input: LoadInputs): number {
  return (input.ach * buildingVolume(input)) / 60;
}

// Sensible occupant gain (BTU/h per person) and latent occupant gain.
const SENSIBLE_PER_OCCUPANT = 230;
const LATENT_PER_OCCUPANT = 200;
const BTU_PER_WATT = 3.412;
// Sensible / latent air-property constants at standard conditions.
const SENSIBLE_AIR_FACTOR = 1.08; // BTU/h per CFM per °F
const LATENT_AIR_FACTOR = 0.68; // BTU/h per CFM per grain

export function calculateLoads(input: LoadInputs): LoadResults {
  const heatingDT = Math.max(0, input.indoorWinter - input.outdoorWinter);
  const coolingDT = Math.max(0, input.outdoorSummer - input.indoorSummer);

  const opaqueWall = netWallArea(input);
  const cfm = infiltrationCFM(input);

  const uWall = uFromR(input.wallR);
  const uCeiling = uFromR(input.ceilingR);
  const uFloor = uFromR(input.floorR);
  const uDoor = uFromR(input.doorR);

  // --- Heating (no solar or internal credit) ---
  const hWalls = uWall * opaqueWall * heatingDT;
  const hWindows = input.windowU * input.windowArea * heatingDT;
  const hDoors = uDoor * input.doorArea * heatingDT;
  const hCeiling = uCeiling * input.floorArea * heatingDT;
  const hFloor = uFloor * input.floorArea * heatingDT;
  const hInfil = SENSIBLE_AIR_FACTOR * cfm * heatingDT;

  const heatingTotal = hWalls + hWindows + hDoors + hCeiling + hFloor + hInfil;

  // --- Cooling sensible ---
  const cWalls = uWall * opaqueWall * coolingDT;
  const cWindowsCond = input.windowU * input.windowArea * coolingDT;
  const cDoors = uDoor * input.doorArea * coolingDT;
  const cCeiling = uCeiling * input.floorArea * coolingDT;
  const cFloor = uFloor * input.floorArea * coolingDT;
  const cInfilSensible = SENSIBLE_AIR_FACTOR * cfm * coolingDT;
  const cSolar = input.windowArea * input.windowSHGC * input.solarGainPerSqft;
  const cOccupants = input.occupants * SENSIBLE_PER_OCCUPANT;
  const cAppliances = input.applianceWatts * BTU_PER_WATT;

  const coolingSensible =
    cWalls +
    cWindowsCond +
    cDoors +
    cCeiling +
    cFloor +
    cInfilSensible +
    cSolar +
    cOccupants +
    cAppliances;

  // --- Cooling latent ---
  const latentInfiltration = LATENT_AIR_FACTOR * cfm * input.grainsDifference;
  const latentOccupants = input.occupants * LATENT_PER_OCCUPANT;
  const coolingLatent = latentInfiltration + latentOccupants;

  const coolingTotal = coolingSensible + coolingLatent;

  return {
    heating: {
      total: heatingTotal,
      breakdown: {
        walls: hWalls,
        windows: hWindows,
        doors: hDoors,
        ceiling: hCeiling,
        floor: hFloor,
        infiltration: hInfil,
      },
    },
    cooling: {
      sensible: coolingSensible,
      latent: coolingLatent,
      total: coolingTotal,
      tons: coolingTotal / 12000,
      breakdown: {
        walls: cWalls,
        windows: cWindowsCond,
        doors: cDoors,
        ceiling: cCeiling,
        floor: cFloor,
        infiltration: cInfilSensible,
        solar: cSolar,
        occupants: cOccupants,
        appliances: cAppliances,
        latentInfiltration,
        latentOccupants,
      },
    },
  };
}
