import { describe, expect, it } from "vitest";
import {
  calculateLoads,
  infiltrationCFM,
  netWallArea,
  uFromR,
  type LoadInputs,
} from "./hvac";

const base: LoadInputs = {
  indoorWinter: 70,
  indoorSummer: 75,
  outdoorWinter: 20,
  outdoorSummer: 95,
  floorArea: 2000,
  ceilingHeight: 8,
  wallArea: 1600,
  windowArea: 300,
  doorArea: 40,
  wallR: 13,
  ceilingR: 30,
  floorR: 19,
  doorR: 3,
  windowU: 0.5,
  windowSHGC: 0.5,
  ach: 0.5,
  occupants: 4,
  applianceWatts: 1000,
  solarGainPerSqft: 200,
  grainsDifference: 30,
};

describe("helpers", () => {
  it("derives U-factor from R-value", () => {
    expect(uFromR(4)).toBe(0.25);
    expect(uFromR(0)).toBe(0); // guarded
  });

  it("nets glazing and doors out of wall area", () => {
    expect(netWallArea(base)).toBe(1600 - 300 - 40);
  });

  it("computes infiltration airflow from ACH and volume", () => {
    // 0.5 ACH * (2000 * 8) ft³ / 60 = 133.33 CFM
    expect(infiltrationCFM(base)).toBeCloseTo(133.33, 1);
  });
});

describe("calculateLoads", () => {
  const r = calculateLoads(base);

  it("produces positive heating and cooling totals", () => {
    expect(r.heating.total).toBeGreaterThan(0);
    expect(r.cooling.total).toBeGreaterThan(0);
  });

  it("cooling total equals sensible plus latent", () => {
    expect(r.cooling.total).toBeCloseTo(r.cooling.sensible + r.cooling.latent, 5);
  });

  it("derives tonnage from total at 12,000 BTU/h per ton", () => {
    expect(r.cooling.tons).toBeCloseTo(r.cooling.total / 12000, 5);
  });

  it("scales heating with the indoor/outdoor temperature difference", () => {
    const colder = calculateLoads({ ...base, outdoorWinter: 0 });
    expect(colder.heating.total).toBeGreaterThan(r.heating.total);
  });

  it("clamps loads to zero when there is no driving temperature difference", () => {
    const noHeat = calculateLoads({ ...base, outdoorWinter: 70 });
    expect(noHeat.heating.total).toBe(0);
  });

  it("adds solar gain only on the cooling side", () => {
    const moreGlass = calculateLoads({ ...base, solarGainPerSqft: 400 });
    expect(moreGlass.cooling.sensible).toBeGreaterThan(r.cooling.sensible);
    expect(moreGlass.heating.total).toBe(r.heating.total);
  });
});
