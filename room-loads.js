/*
 * LoadMaster Pro AI — RoomIQ room-by-room load distribution.
 *
 * A block load says how many tons the house needs. It cannot say why the
 * back bedroom is always hot — and that complaint is what puts the rep in
 * the driveway in the first place. This module distributes the already-
 * computed whole-house load across the rooms the rep enters, then compares
 * each room's REQUIRED airflow against what its registers can actually
 * deliver. The gap between those two numbers is the diagnosis.
 *
 * Method, and its one important property: per-room loads are built from real
 * room geometry (exterior wall area, glass area and orientation, roof or
 * floor exposure, occupancy and appliances by room type), and are then
 * SCALED so that each category sums exactly to the corresponding whole-house
 * figure from loadcalc.js. That reconciliation is deliberate. It means the
 * room breakdown can never contradict the tonnage on the same page, and it
 * inherits the whole-house engine's validation instead of introducing a
 * second, unvalidated total. What the room math decides is the SHARE each
 * room takes, not the size of the pie.
 *
 * This is a diagnostic aid in the spirit of Manual J's room-by-room
 * procedure, not a substitute for it: a stamped room-by-room needs measured
 * dimensions, real window schedules and a Manual D duct design.
 *
 * Exposed as window.RoomLoads (and globalThis for Node tests).
 */
(function (root) {
  "use strict";

  /*
   * Orientation multipliers on the house's average solar flux. West is worst
   * for residential peak cooling: the sun is low and the afternoon is already
   * the hottest part of the day, which is exactly why the west-facing bonus
   * room is the room people complain about. North sees diffuse sky only.
   * These are relative weights — the reconciliation step below normalizes
   * them against the whole-house solar figure, so what matters is their
   * ratio, not their absolute scale.
   */
  var ORIENTATION = {
    n: { mult: 0.35, label: "North" },
    ne: { mult: 0.55, label: "Northeast" },
    e: { mult: 0.85, label: "East" },
    se: { mult: 0.80, label: "Southeast" },
    s: { mult: 0.85, label: "South" },
    sw: { mult: 1.30, label: "Southwest" },
    w: { mult: 1.45, label: "West" },
    nw: { mult: 0.95, label: "Northwest" },
    unknown: { mult: 0.85, label: "Not specified" }
  };

  /*
   * Room types. `people` is design occupancy for the cooling hour, `applBtu`
   * is sensible appliance/plug gain beyond the house-wide lighting figure,
   * and `applLatent` covers moisture (cooking and bathing are the two rooms
   * that actually add water to the air).
   */
  var ROOM_TYPES = {
    bedroom:    { label: "Bedroom",        people: 1.5, applBtu: 200,  applLatent: 0,   supply: 1 },
    primary:    { label: "Primary bedroom",people: 2,   applBtu: 300,  applLatent: 0,   supply: 2 },
    living:     { label: "Living / family",people: 3,   applBtu: 800,  applLatent: 0,   supply: 2 },
    kitchen:    { label: "Kitchen",        people: 2,   applBtu: 1600, applLatent: 500, supply: 2 },
    dining:     { label: "Dining",         people: 2,   applBtu: 200,  applLatent: 0,   supply: 1 },
    office:     { label: "Office",         people: 1,   applBtu: 600,  applLatent: 0,   supply: 1 },
    bath:       { label: "Bathroom",       people: 0.5, applBtu: 100,  applLatent: 300, supply: 1 },
    bonus:      { label: "Bonus / over garage", people: 2, applBtu: 400, applLatent: 0, supply: 2 },
    basement:   { label: "Basement",       people: 1,   applBtu: 300,  applLatent: 0,   supply: 2 },
    other:      { label: "Other",          people: 1,   applBtu: 300,  applLatent: 0,   supply: 1 }
  };

  /*
   * Field rules for what a supply register can actually move. A typical
   * residential supply (4x10 or 4x12 wall/floor register, or a 6" round
   * ceiling diffuser) carries roughly 100 CFM before it gets noisy. This is a
   * rule of thumb for diagnosis, not a Manual D calculation — a properly
   * designed high-throw diffuser on adequate static pressure does more, and a
   * crushed flex run buried in insulation does far less.
   */
  var CFM_PER_SUPPLY = 100;
  // Below this fraction of required airflow a room is called starved; the
  // number comes from the practical experience that a room 20% light is
  // noticeable on a design day and a room 40% light is a complaint.
  var STARVED_FRACTION = 0.80;
  var SEVERE_FRACTION = 0.60;

  function typeDef(t) { return ROOM_TYPES[t] || ROOM_TYPES.other; }
  function orientDef(o) { return ORIENTATION[String(o || "unknown").toLowerCase()] || ORIENTATION.unknown; }

  /*
   * Per-room raw component estimates, before reconciliation.
   *
   * Geometry: a room of area A with `exteriorWalls` exposed sides is treated
   * as roughly square, so each exposed side is about sqrt(A) long. That is
   * the same square-plan simplification the whole-house engine already makes
   * for the building envelope, applied one level down.
   */
  function rawRoom(room, ctx) {
    var area = Math.max(1, Number(room.area) || 0);
    var ceiling = Number(room.ceiling) > 0 ? Number(room.ceiling) : ctx.ceiling;
    var walls = Math.max(0, Math.min(4, Number(room.exteriorWalls != null ? room.exteriorWalls : 1)));
    var side = Math.sqrt(area);
    var grossWall = side * walls * ceiling;

    // Glass: an explicit entry wins; otherwise the house's window fraction is
    // spread over the room in proportion to how much exterior wall it has.
    // An interior room with no exposed wall therefore gets no glass, which is
    // right, and a corner room gets roughly double a single-exposure room.
    var winArea = Number(room.windowArea);
    if (!(winArea >= 0)) winArea = ctx.windowFrac * area * (walls / 1.6);
    winArea = Math.min(winArea, Math.max(0, grossWall * 0.6));   // glass can't exceed ~60% of the wall
    var netWall = Math.max(0, grossWall - winArea);

    var roofArea = room.topFloor ? area : 0;
    var floorArea = room.overUnconditioned ? area : 0;
    var t = typeDef(room.type);
    var orient = orientDef(room.orientation);

    // Conduction is expressed in UA terms so the reconciliation below can
    // scale it against the house's own conduction figure.
    var uaCool = ctx.uWall * netWall + ctx.uWin * winArea + ctx.uRoof * roofArea;
    var uaHeat = uaCool + ctx.uFloor * floorArea;
    // A room over a garage or crawl loses through its floor in winter AND
    // gains through it in summer when that space runs hot; the whole-house
    // engine drops the floor for cooling (ground-coupled), so only an
    // explicitly-unconditioned floor contributes here.
    if (floorArea > 0) uaCool += ctx.uFloor * floorArea * 0.5;

    return {
      area: area, ceiling: ceiling, exteriorWalls: walls, windowArea: winArea,
      grossWall: grossWall, netWall: netWall, roofArea: roofArea, floorArea: floorArea,
      orientation: orient, typeDef: t,
      rawConductionCool: uaCool * ctx.dtCool,
      rawConductionHeat: uaHeat * ctx.dtHeat,
      rawSolar: winArea * ctx.shgc * ctx.solarFlux * orient.mult,
      rawPeopleSens: t.people * 230,
      rawPeopleLat: t.people * 200,
      rawInternal: t.applBtu + area * 0.6,
      rawLatentAppl: t.applLatent,
      // Leakage follows exposed envelope area, not floor area: an interior
      // hallway does not leak, a corner room with three windows does.
      rawInfilShare: grossWall + winArea * 1.5
    };
  }

  function sum(arr, fn) { return arr.reduce(function (a, r) { return a + fn(r); }, 0); }
  // Scale factor that makes a set of raw parts add up to a known total.
  // Zero raw total means the category doesn't apply to any entered room, so
  // the factor is irrelevant and 0 keeps it from becoming Infinity/NaN.
  function factor(total, raw) { return raw > 0 ? total / raw : 0; }

  /*
   * distribute(opts) -> per-room loads, airflow and diagnosis.
   *
   * opts:
   *   rooms   [{ name, area, type, exteriorWalls, orientation, ceiling,
   *              windowArea, topFloor, overUnconditioned, supplies, supplyCfm }]
   *   house   a loadcalc.js compute() result
   *   inputs  the same effective inputs handed to compute() (area, ceiling,
   *           windowFrac, quality/envelope values)
   */
  function distribute(opts) {
    var o = opts || {};
    var rooms = (o.rooms || []).filter(function (r) { return r && Number(r.area) > 0; });
    var house = o.house;
    if (!rooms.length || !house) return null;

    var env = house.envelope || {};
    var q = o.quality || {};
    var ctx = {
      ceiling: Number(o.ceiling) > 0 ? Number(o.ceiling) : 9,
      windowFrac: Number(o.windowFrac) > 0 ? Number(o.windowFrac) : 0.15,
      uWall: q.uWall != null ? q.uWall : 0.080,
      uWin: env.windowU != null ? env.windowU : (q.uWin != null ? q.uWin : 0.50),
      uRoof: env.atticR > 0 ? 1 / (env.atticR + 3) : (q.uRoof != null ? q.uRoof : 0.045),
      uFloor: q.uFloor != null ? q.uFloor : 0.060,
      shgc: env.windowSHGC != null ? env.windowSHGC : (q.shgc != null ? q.shgc : 0.45),
      solarFlux: 70,
      dtCool: Math.max(1, (o.cooling1 || 95) - (o.indoorCool || 75)),
      dtHeat: Math.max(1, (o.indoorHeat || 70) - (o.heating99 != null ? o.heating99 : 20))
    };

    var raws = rooms.map(function (r) { return rawRoom(r, ctx); });

    // House-level component totals to reconcile against.
    //
    // Note what loadcalc.js's cooling breakdown actually is: five categories
    // that already include BOTH sensible and latent (people carries occupant
    // moisture, infiltration carries humid outdoor air) and are already
    // multiplied by the duct factor. They sum exactly to cooling.total. So
    // these five factors reconcile the room TOTALS, and the latent split
    // below is carved back out of that total rather than added on top of it.
    var cb = house.cooling.breakdown;
    var fConduction = factor(cb.conduction, sum(raws, function (r) { return r.rawConductionCool; }));
    var fSolar = factor(cb.solar, sum(raws, function (r) { return r.rawSolar; }));
    var fPeople = factor(cb.people, sum(raws, function (r) { return r.rawPeopleSens; }));
    var fInternal = factor(cb.internal, sum(raws, function (r) { return r.rawInternal; }));
    var fInfil = factor(cb.infiltration, sum(raws, function (r) { return r.rawInfilShare; }));
    var fHeat = factor(house.heating.total, sum(raws, function (r) { return r.rawConductionHeat + r.rawInfilShare * ctx.dtHeat * 0.02; }));
    var fLatent = factor(house.cooling.latent, sum(raws, function (r) { return r.rawPeopleLat + r.rawLatentAppl + r.rawInfilShare * 0.5; }));

    var enteredArea = sum(raws, function (r) { return r.area; });
    var houseArea = Number(o.area) > 0 ? Number(o.area) : enteredArea;
    var coverage = Math.min(1, enteredArea / houseArea);

    var out = rooms.map(function (room, i) {
      var r = raws[i];
      var conduction = r.rawConductionCool * fConduction;
      var solar = r.rawSolar * fSolar;
      var people = r.rawPeopleSens * fPeople;
      var internal = r.rawInternal * fInternal;
      var infiltration = r.rawInfilShare * fInfil;
      var cooling = conduction + solar + people + internal + infiltration;
      // Latent is a share OF that total, not an addition to it. Capped at 60%
      // of the room so a small wet room (a bath) can't be driven to a
      // near-zero sensible load, which would then starve it of supply air.
      var latent = Math.min((r.rawPeopleLat + r.rawLatentAppl + r.rawInfilShare * 0.5) * fLatent, cooling * 0.6);
      var sensible = Math.max(0, cooling - latent);
      var heating = (r.rawConductionHeat + r.rawInfilShare * ctx.dtHeat * 0.02) * fHeat;
      return {
        name: String(room.name || r.typeDef.label),
        type: room.type || "other",
        typeLabel: r.typeDef.label,
        area: Math.round(r.area),
        exteriorWalls: r.exteriorWalls,
        orientation: room.orientation || "unknown",
        orientationLabel: r.orientation.label,
        windowArea: Math.round(r.windowArea),
        topFloor: !!room.topFloor,
        overUnconditioned: !!room.overUnconditioned,
        breakdown: {
          conduction: Math.round(conduction), solar: Math.round(solar), people: Math.round(people),
          internal: Math.round(internal), infiltration: Math.round(infiltration)
        },
        sensible: Math.round(sensible),
        latent: Math.round(latent),
        cooling: Math.round(cooling),
        heating: Math.round(heating),
        btuPerSqFt: Math.round(cooling / r.area * 10) / 10,
        supplies: room.supplies != null ? Number(room.supplies) : null,
        supplyCfm: room.supplyCfm != null ? Number(room.supplyCfm) : null,
        _sensible: sensible
      };
    });

    // ---------- airflow ----------
    // Supply air is apportioned by SENSIBLE load, which is what actually sets
    // room temperature; latent load is a coil property, not a register one.
    var totalSens = sum(out, function (r) { return r._sensible; });
    var houseCfm = house.equipment.airflowCfm;
    var houseSqFt = houseArea;
    out.forEach(function (r) {
      r.requiredCfm = totalSens > 0 ? Math.round(houseCfm * coverage * (r._sensible / totalSens) / 5) * 5 : 0;
      // What the room can actually get: an entered CFM wins, else register count.
      r.actualCfm = r.supplyCfm > 0 ? Math.round(r.supplyCfm)
        : (r.supplies > 0 ? r.supplies * CFM_PER_SUPPLY : null);
      r.cfmPerSqFt = r.area > 0 ? Math.round(r.requiredCfm / r.area * 100) / 100 : 0;
      r.suppliesSuggested = Math.max(1, Math.ceil(r.requiredCfm / CFM_PER_SUPPLY));
      delete r._sensible;
    });

    // ---------- diagnosis ----------
    var avgBtuSqFt = houseSqFt > 0 ? house.cooling.total / houseSqFt : 0;
    out.forEach(function (r) {
      var flags = [];
      var ratio = r.actualCfm != null && r.requiredCfm > 0 ? r.actualCfm / r.requiredCfm : null;
      if (ratio != null) {
        if (ratio < SEVERE_FRACTION) flags.push({ level: "severe", code: "starved", text: "Getting roughly " + Math.round(ratio * 100) + "% of the air this room needs. This is the room the customer complains about." });
        else if (ratio < STARVED_FRACTION) flags.push({ level: "warn", code: "short", text: "About " + Math.round(ratio * 100) + "% of required airflow — noticeably warm on a design day." });
        else if (ratio > 1.6) flags.push({ level: "info", code: "over", text: "Getting well more air than it needs; a damper here frees up air for the rooms that are short." });
      }
      // A 90 ft² bathroom reads "hot per square foot" purely because of its
      // moisture load, which is not a comfort complaint and not something a
      // rep should be handed as a talking point. Living space only.
      var hotspotEligible = r.area >= 120 && r.type !== "bath";
      if (hotspotEligible && avgBtuSqFt > 0 && r.btuPerSqFt > avgBtuSqFt * 1.35) {
        flags.push({ level: "warn", code: "hotspot", text: "Works " + Math.round(r.btuPerSqFt / avgBtuSqFt * 100 - 100) + "% harder per square foot than the house average, so equal-sized ducts will leave it behind." });
      }
      if (r.overUnconditioned && r.topFloor) flags.push({ level: "warn", code: "sandwich", text: "Unconditioned space above and below — the hardest room in any house to keep even." });
      else if (r.overUnconditioned) flags.push({ level: "info", code: "floor", text: "Floor sits over unconditioned space; insulating it is usually cheaper than adding capacity." });
      // A fully interior room legitimately has no envelope heat loss, so its
      // heating figure is zero. Say why, or the row reads as a broken number.
      if (r.exteriorWalls === 0) flags.push({ level: "info", code: "interior", text: "No exterior wall, so no envelope heat loss of its own — its load is people, lights and appliances, and it borrows temperature from the rooms around it." });
      var west = r.orientation === "w" || r.orientation === "sw";
      if (west && r.windowArea >= 25) flags.push({ level: "info", code: "westglass", text: "Large west-facing glass drives an afternoon peak that shading or low-SHGC glass fixes more cheaply than tonnage." });
      r.flags = flags;
      r.worst = flags.reduce(function (a, f) { return (a === "severe" || f.level === "severe") ? "severe" : (a === "warn" || f.level === "warn") ? "warn" : f.level; }, null);
    });

    var starved = out.filter(function (r) { return r.flags.some(function (f) { return f.code === "starved" || f.code === "short"; }); });
    var over = out.filter(function (r) { return r.flags.some(function (f) { return f.code === "over"; }); });
    var measured = out.filter(function (r) { return r.actualCfm != null; });

    return {
      rooms: out,
      totals: {
        rooms: out.length,
        area: Math.round(enteredArea),
        houseArea: Math.round(houseArea),
        coveragePct: Math.round(coverage * 100),
        cooling: Math.round(sum(out, function (r) { return r.cooling; })),
        heating: Math.round(sum(out, function (r) { return r.heating; })),
        requiredCfm: Math.round(sum(out, function (r) { return r.requiredCfm; }))
      },
      diagnosis: buildDiagnosis(out, starved, over, measured, coverage),
      cfmPerSupply: CFM_PER_SUPPLY,
      disclosure: "Room loads are the whole-house load distributed by each room's own geometry, glass, orientation and use, scaled so the rooms sum to the house total on this same report. Airflow is apportioned by sensible load. Register capacity is screened against a field rule of about " + CFM_PER_SUPPLY + " CFM per standard supply — a diagnostic, not a Manual D duct design."
    };
  }

  // Plain sentences a rep can say out loud. Each is emitted only when the
  // numbers support it; nothing here is generic filler.
  function buildDiagnosis(rooms, starved, over, measured, coverage) {
    var lines = [];
    if (!measured.length) {
      lines.push("Add each room's supply register count to turn this into a comfort diagnosis — that's what shows whether a hot room is a duct problem or an equipment problem.");
    }
    var worst = starved.slice().sort(function (a, b) {
      return (a.actualCfm / a.requiredCfm) - (b.actualCfm / b.requiredCfm);
    })[0];
    if (worst) {
      lines.push(worst.name + " needs about " + worst.requiredCfm + " CFM and is set up to get roughly " + worst.actualCfm + ". That gap is why it runs warm, and no amount of extra tonnage fixes it — a bigger system just short-cycles and leaves that room the same.");
      lines.push("Fixing " + worst.name + " means air, not tons: " + worst.suppliesSuggested + " supplies instead of " + (worst.supplies || Math.max(1, Math.round(worst.actualCfm / 100))) + ", or a larger duct to it.");
    }
    if (over.length && starved.length) {
      var names = over.map(function (r) { return r.name; });
      var list = names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
      lines.push("There is air to work with: " + list + (names.length === 1 ? " is" : " are") + " over-supplied, so balancing dampers can move some of it to the rooms that are short before anyone spends money on equipment.");
    }
    var hotspots = rooms.filter(function (r) { return r.flags.some(function (f) { return f.code === "hotspot"; }); });
    if (hotspots.length && !worst) {
      lines.push(hotspots[0].name + " carries the heaviest load per square foot in the house. If the ducts were sized by room size rather than room load, this is the room that ends up uncomfortable.");
    }
    if (coverage < 0.85) {
      lines.push("Rooms entered cover about " + Math.round(coverage * 100) + "% of the conditioned area, so the airflow figures are shares of that portion. Add the remaining rooms for a complete picture.");
    }
    return lines;
  }

  var api = {
    distribute: distribute, ROOM_TYPES: ROOM_TYPES, ORIENTATION: ORIENTATION,
    CFM_PER_SUPPLY: CFM_PER_SUPPLY, _rawRoom: rawRoom
  };
  root.RoomLoads = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
