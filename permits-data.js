/*
 * LoadMaster Pro — PermitIQ data engine.
 *
 * Sources of truth embedded here:
 *  - Federal minimum efficiency standards (DOE, effective Jan 1 2023):
 *    regional SEER2 minimums for central A/C, national heat-pump minimums,
 *    furnace AFUE minimum. These are hard legal floors by state.
 *  - Model-code requirements (IRC / IMC / NEC / IECC) that the vast majority
 *    of US jurisdictions adopt, flagged with typical values where local
 *    amendments vary (marked verify:true → "verify with the city").
 *
 * PermitIQ is a preparation aid: every output instructs the contractor to
 * confirm final values with the authority having jurisdiction (AHJ).
 */
(function (root) {
  "use strict";

  var STATE_CODES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
    "colorado": "CO", "connecticut": "CT", "delaware": "DE", "district of columbia": "DC",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID", "illinois": "IL",
    "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
    "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA",
    "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY"
  };

  // DOE 2023 regional standard groupings for central air conditioners.
  var SOUTHEAST = ["AL", "AR", "DE", "DC", "FL", "GA", "HI", "KY", "LA", "MD", "MS", "NC", "OK", "SC", "TN", "TX", "VA"];
  var SOUTHWEST = ["AZ", "CA", "NM", "NV"];

  function stateCode(name) {
    if (!name) return null;
    var n = String(name).trim();
    if (/^[A-Za-z]{2}$/.test(n)) return n.toUpperCase();
    return STATE_CODES[n.toLowerCase()] || null;
  }

  function doeRegion(code) {
    if (SOUTHWEST.indexOf(code) !== -1) return "southwest";
    if (SOUTHEAST.indexOf(code) !== -1) return "southeast";
    return "north";
  }

  // Federal minimum efficiencies (DOE, in force since Jan 1 2023).
  function efficiency(code) {
    var region = doeRegion(code || "");
    var acSmall, acLarge, regionLabel;
    if (region === "north") {
      regionLabel = "DOE North region";
      acSmall = "13.4 SEER2"; acLarge = "13.4 SEER2";
    } else if (region === "southeast") {
      regionLabel = "DOE Southeast region";
      acSmall = "14.3 SEER2"; acLarge = "13.8 SEER2";
    } else {
      regionLabel = "DOE Southwest region";
      acSmall = "14.3 SEER2 + 11.7 EER2"; acLarge = "13.8 SEER2 + 11.2 EER2";
    }
    var rows = [
      { k: "Central A/C < 45,000 BTU/h", v: acSmall + " minimum" },
      { k: "Central A/C ≥ 45,000 BTU/h", v: acLarge + " minimum" },
      { k: "Heat pump (all regions)", v: "14.3 SEER2 · 7.5 HSPF2 minimum" },
      { k: "Gas furnace", v: "80% AFUE federal minimum" }
    ];
    var note = null;
    if (code === "CA") note = "California Title 24 adds stricter requirements: HERS verification (refrigerant charge + airflow), duct leakage testing, and prescriptive heat-pump baselines in many climate zones.";
    if (code === "WA") note = "Washington's state energy code goes beyond federal minimums and strongly favors heat-pump equipment in new work.";
    if (code === "FL") note = "Florida requires product approval numbers on permit applications and has wind-borne-debris tie-down rules for condensers in HVHZ counties.";
    return { region: region, regionLabel: regionLabel, rows: rows, note: note };
  }

  /*
   * Model-code requirement checklist (IRC/IMC/NEC/IECC as commonly adopted).
   * verify:true means the exact number is a local amendment — the app renders
   * these with a "verify with the city" tag.
   */
  var CHECKLIST = [
    { cat: "Permit", text: "A mechanical permit is required for new installations AND like-for-like changeouts in nearly all US jurisdictions; many cities issue same-day online.", verify: false },
    { cat: "Permit", text: "Load calculation documentation (ACCA Manual J, with Manual S equipment selection and Manual D for new ducts) is required with the application per IRC M1401.3 in most jurisdictions.", verify: false },
    { cat: "Outdoor unit", text: "Set on a level pad above grade; maintain manufacturer clearances (typically 12–24 in at sides/service side and 48–60 in above the fan discharge).", verify: false },
    { cat: "Outdoor unit", text: "Property-line setback: commonly 2–5 ft to the side/rear lot line, and units may not sit in platted easements. Some cities restrict placement in front setbacks.", verify: true },
    { cat: "Outdoor unit", text: "Keep ≥3 ft clearance from gas and electric meters and from openable windows in many amendments; check pool-equipment separation where applicable.", verify: true },
    { cat: "Outdoor unit", text: "Noise ordinances in many cities cap equipment sound at roughly 50–65 dBA measured at the property line — variable-speed condensers help here.", verify: true },
    { cat: "Electrical", text: "Service disconnect within sight of the unit; conductor/breaker sized to nameplate MCA/MOCP; a 125V GFCI service receptacle within 25 ft of the equipment (NEC 210.63).", verify: false },
    { cat: "Refrigerant", text: "Line set insulated; locking refrigerant caps or otherwise tamper-resistant access required by IMC 1101.10 as adopted in many areas.", verify: true },
    { cat: "Condensate", text: "Primary condensate to an approved location plus secondary protection (auxiliary pan with float switch) for air handlers above finished space (IRC M1411).", verify: false },
    { cat: "Ducts", text: "New or substantially altered ducts must be sealed; duct leakage testing is required where IECC 2015+ is adopted.", verify: true },
    { cat: "Combustion & safety", text: "Furnace changeouts: verify combustion air and venting; CO alarms are commonly required to be present/added when a mechanical permit is pulled.", verify: true },
    { cat: "Inspection", text: "A final inspection is required; some states (notably CA) also require third-party refrigerant-charge/airflow verification.", verify: false }
  ];

  // What a typical mechanical permit application package must contain.
  var SUBMITTAL = [
    "Completed mechanical permit application (city form or online portal)",
    "Load calculation report (this LoadMaster report; full Manual J for final submittal where required)",
    "Equipment specification: make/model, capacity, SEER2/HSPF2/AFUE ratings",
    "Site/plot sketch or photos showing outdoor-unit location and setbacks",
    "Contractor license number and proof of insurance",
    "Permit fee (commonly $50–$250 for residential changeouts)"
  ];

  function permitOfficeUrl(city, state) {
    var q = encodeURIComponent((city ? city + " " : "") + (state ? state + " " : "") + "mechanical HVAC permit application building department");
    return "https://www.google.com/search?q=" + q;
  }

  var api = {
    stateCode: stateCode,
    doeRegion: doeRegion,
    efficiency: efficiency,
    CHECKLIST: CHECKLIST,
    SUBMITTAL: SUBMITTAL,
    permitOfficeUrl: permitOfficeUrl
  };
  root.PermitData = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
