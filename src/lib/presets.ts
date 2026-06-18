import type { LoadInputs } from "./hvac";

/** A regional design-condition preset (ASHRAE-style approximations). */
export interface ClimatePreset {
  id: string;
  label: string;
  outdoorWinter: number; // 99% heating design temp (°F)
  outdoorSummer: number; // 1% cooling design temp (°F)
  grainsDifference: number; // outdoor−indoor moisture (grains/lb)
  solarGainPerSqft: number; // effective peak glazing gain (BTU/h·ft²)
}

export const CLIMATE_PRESETS: ClimatePreset[] = [
  {
    id: "hot-humid",
    label: "Hot–Humid (Miami, Houston)",
    outdoorWinter: 40,
    outdoorSummer: 95,
    grainsDifference: 48,
    solarGainPerSqft: 230,
  },
  {
    id: "hot-dry",
    label: "Hot–Dry (Phoenix, Las Vegas)",
    outdoorWinter: 35,
    outdoorSummer: 108,
    grainsDifference: 12,
    solarGainPerSqft: 250,
  },
  {
    id: "mixed",
    label: "Mixed (Atlanta, Dallas)",
    outdoorWinter: 25,
    outdoorSummer: 96,
    grainsDifference: 35,
    solarGainPerSqft: 210,
  },
  {
    id: "marine",
    label: "Marine (Seattle, San Francisco)",
    outdoorWinter: 30,
    outdoorSummer: 83,
    grainsDifference: 18,
    solarGainPerSqft: 180,
  },
  {
    id: "cold",
    label: "Cold (Chicago, Denver)",
    outdoorWinter: 0,
    outdoorSummer: 91,
    grainsDifference: 28,
    solarGainPerSqft: 200,
  },
  {
    id: "very-cold",
    label: "Very Cold (Minneapolis, Fargo)",
    outdoorWinter: -15,
    outdoorSummer: 88,
    grainsDifference: 24,
    solarGainPerSqft: 190,
  },
];

/** Construction-quality presets covering insulation and air leakage. */
export interface ConstructionPreset {
  id: string;
  label: string;
  wallR: number;
  ceilingR: number;
  floorR: number;
  doorR: number;
  windowU: number;
  windowSHGC: number;
  ach: number;
}

export const CONSTRUCTION_PRESETS: ConstructionPreset[] = [
  {
    id: "older",
    label: "Older / leaky (pre-1980)",
    wallR: 7,
    ceilingR: 19,
    floorR: 5,
    doorR: 2,
    windowU: 0.85,
    windowSHGC: 0.7,
    ach: 0.9,
  },
  {
    id: "standard",
    label: "Standard (1990s–2000s code)",
    wallR: 13,
    ceilingR: 30,
    floorR: 13,
    doorR: 3,
    windowU: 0.5,
    windowSHGC: 0.55,
    ach: 0.5,
  },
  {
    id: "efficient",
    label: "Efficient (current IECC)",
    wallR: 20,
    ceilingR: 49,
    floorR: 19,
    doorR: 5,
    windowU: 0.3,
    windowSHGC: 0.4,
    ach: 0.35,
  },
  {
    id: "high-performance",
    label: "High-performance / tight",
    wallR: 28,
    ceilingR: 60,
    floorR: 30,
    doorR: 6,
    windowU: 0.2,
    windowSHGC: 0.3,
    ach: 0.2,
  },
];

export const DEFAULT_INPUTS: LoadInputs = {
  indoorWinter: 70,
  indoorSummer: 75,
  outdoorWinter: 25,
  outdoorSummer: 96,
  floorArea: 1800,
  ceilingHeight: 9,
  wallArea: 1500,
  windowArea: 300,
  doorArea: 40,
  wallR: 13,
  ceilingR: 30,
  floorR: 13,
  doorR: 3,
  windowU: 0.5,
  windowSHGC: 0.55,
  ach: 0.5,
  occupants: 4,
  applianceWatts: 1200,
  solarGainPerSqft: 210,
  grainsDifference: 35,
};
