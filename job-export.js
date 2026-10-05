/*
 * LoadMaster Pro AI — job export (ServiceTitan and anything else).
 *
 * How this integrates with ServiceTitan, and why it is built this way:
 *
 * ServiceTitan's API uses OAuth 2.0 client credentials — a Client ID, Client
 * Secret, App Key and Tenant ID. Two things follow, and they decide the whole
 * design:
 *
 *   1. Those are machine-to-machine secrets. A static web app running in a
 *      browser cannot hold them. Anything shipped to the browser is readable
 *      by whoever is using the browser.
 *   2. ServiceTitan explicitly PROHIBITS "tunneling" — granting a third-party
 *      application you do not own access to your App Key. Asking a contractor
 *      to paste their App Key into this app would be asking them to break
 *      their own ServiceTitan agreement.
 *
 * So this app does not ask for ServiceTitan credentials and never will. It
 * offers the three routes that are legitimate today:
 *
 *   PASTE      a clean, formatted job summary on the clipboard, ready to drop
 *              into a ServiceTitan job note, estimate description or task.
 *              Works right now, for everyone, with nothing to configure.
 *   WEBHOOK    POST the structured result to an automation the shop owns
 *              (Zapier, Make, n8n, or their own endpoint), which holds the
 *              ServiceTitan credentials properly, server-side, under their
 *              own app registration. This is the supported integration path.
 *   FILE       a JSON download for an importer or a developer to consume.
 *
 * A shop that wants a true native integration needs a ServiceTitan Certified
 * App or their own Customer-Built App; this module's JSON is shaped to be the
 * payload either of those would consume.
 *
 * Exposed as window.JobExport (and globalThis for Node tests).
 */
(function (root) {
  "use strict";

  var SCHEMA_VERSION = "lmp-job-1";

  function n(v) { return typeof v === "number" && isFinite(v) ? v : null; }
  function money(v) { return v == null ? null : Math.round(v); }

  /*
   * The machine-readable payload. Deliberately flat and explicitly named: the
   * thing on the far end is usually a no-code automation step where someone
   * maps fields by hand, and `cooling_btuh` is mappable where a nested blob
   * is not.
   */
  function toJson(ctx) {
    var c = ctx || {};
    var r = c.result, cl = c.climate, e = c.effective, g = c.geo, job = c.jobType;
    if (!r) return null;
    var out = {
      schema: SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      source: "LoadMaster Pro AI",

      address: g && g.label ? g.label : null,
      city: g && g.city || null,
      state: g && g.state || null,
      postcode: g && g.postcode || null,

      job_type: job ? job.label : null,
      job_type_id: job ? job.id : null,
      job_notes: c.jobCustom || null,

      conditioned_area_sqft: n(e && e.area),
      bedrooms: n(e && e.bedrooms),
      year_built: n(e && e.yearBuilt),

      heating_btuh: n(r.heating && r.heating.total),
      cooling_btuh: n(r.cooling && r.cooling.total),
      cooling_sensible_btuh: n(r.cooling && r.cooling.sensible),
      cooling_latent_btuh: n(r.cooling && r.cooling.latent),
      recommended_tons: n(r.recommendedTons),
      tons_single_stage: n(r.sizing && r.sizing.single),
      tons_two_stage: n(r.sizing && r.sizing.two),
      tons_variable_capacity: n(r.sizing && r.sizing.variable),
      required_airflow_cfm: n(r.equipment && r.equipment.airflowCfm),
      furnace_output_btuh: n(r.equipment && r.equipment.furnaceOutput),
      heat_pump_balance_point_f: n(r.heatpump && r.heatpump.balanceF),
      backup_heat_kw: n(r.heatpump && r.heatpump.auxKw),

      design_summer_f: n(cl && cl.cooling1),
      design_winter_f: n(cl && cl.heating99),
      design_grains: n(cl && cl.outGrains),
      elevation_ft: n(cl && cl.elevFt),
      climate_zone: n(cl && cl.climateZone),
      climate_source: cl ? (cl.source === "live" ? "on-site hourly weather" : "nearest station") : null,

      disclaimer: "Manual J-style estimate from LoadMaster Pro AI. Confirm equipment selection with a licensed professional before contract."
    };

    if (c.energy && c.energy.existing) {
      out.existing_tons = n(c.energy.existing.tons);
      out.existing_year = n(c.energy.existing.year);
      out.existing_annual_cost_usd = money(c.energy.existing.energy && c.energy.existing.energy.totalCost);
      if (c.energy.existing.rightSize) {
        out.existing_pct_of_load = n(c.energy.existing.rightSize.pct);
        out.existing_size_verdict = c.energy.existing.rightSize.verdict;
      }
    }
    if (c.rebates && c.rebates.programs) {
      out.incentive_total_usd = money(c.rebates.totals.capped);
      out.incentive_programs = c.rebates.programs.map(function (p) {
        return {
          name: p.name, administrator: p.administrator, type: p.typeLabel,
          amount_usd: money(p.amountMax), amount_text: p.amountText,
          income_qualified: !!p.incomeQualified, apply_url: p.applyUrl, source_url: p.source
        };
      });
    }
    if (c.rooms && c.rooms.rooms) {
      out.rooms = c.rooms.rooms.map(function (x) {
        return { name: x.name, area_sqft: x.area, cooling_btuh: x.cooling, heating_btuh: x.heating,
                 required_cfm: x.requiredCfm, actual_cfm: x.actualCfm };
      });
    }
    return out;
  }

  function fmt(v) { return v == null ? "—" : Number(v).toLocaleString("en-US"); }

  /*
   * The pasteable version. Plain text on purpose: a ServiceTitan job note,
   * estimate description or task field takes text, not markdown and not HTML,
   * and a rep pasting into a phone wants it to survive intact.
   */
  function toText(ctx) {
    var j = toJson(ctx);
    if (!j) return "";
    var L = [];
    L.push("LOAD CALCULATION — LoadMaster Pro AI");
    if (j.address) L.push(j.address);
    if (j.job_type) L.push("Job: " + j.job_type + (j.job_notes ? " (" + j.job_notes + ")" : ""));
    L.push("");
    L.push("DESIGN LOADS");
    L.push("  Heating:  " + fmt(j.heating_btuh) + " BTU/h");
    L.push("  Cooling:  " + fmt(j.cooling_btuh) + " BTU/h  (" + fmt(j.cooling_sensible_btuh) + " sensible / " + fmt(j.cooling_latent_btuh) + " latent)");
    L.push("  Area:     " + fmt(j.conditioned_area_sqft) + " sq ft");
    L.push("");
    L.push("EQUIPMENT");
    L.push("  Recommended:     " + j.recommended_tons + " ton");
    L.push("  Single-stage:    " + j.tons_single_stage + " ton");
    L.push("  Two-stage:       " + j.tons_two_stage + " ton");
    L.push("  Variable:        " + j.tons_variable_capacity + " ton");
    L.push("  Airflow:         " + fmt(j.required_airflow_cfm) + " CFM");
    if (j.furnace_output_btuh) L.push("  Furnace output:  " + fmt(j.furnace_output_btuh) + " BTU/h");
    if (j.heat_pump_balance_point_f != null) {
      L.push("  HP balance pt:   " + j.heat_pump_balance_point_f + "°F" + (j.backup_heat_kw ? " (" + j.backup_heat_kw + " kW backup at design)" : ""));
    }
    L.push("");
    L.push("DESIGN CONDITIONS");
    L.push("  Summer " + j.design_summer_f + "°F / Winter " + j.design_winter_f + "°F" +
      (j.climate_zone ? " · IECC zone " + j.climate_zone : "") + (j.climate_source ? " · " + j.climate_source : ""));

    if (j.existing_tons) {
      L.push("");
      L.push("EXISTING SYSTEM");
      L.push("  " + j.existing_tons + " ton" + (j.existing_year ? ", installed " + j.existing_year : "") +
        (j.existing_annual_cost_usd != null ? " · ~$" + fmt(j.existing_annual_cost_usd) + "/yr to run" : ""));
      if (j.existing_pct_of_load) L.push("  " + j.existing_pct_of_load + "% of calculated load (" + j.existing_size_verdict + ")");
    }
    if (j.incentive_programs && j.incentive_programs.length) {
      L.push("");
      L.push("INCENTIVES FOUND (verify before contract)");
      L.push("  Estimated total: $" + fmt(j.incentive_total_usd));
      j.incentive_programs.forEach(function (p) {
        L.push("  - " + p.name + (p.amount_usd != null ? " — up to $" + fmt(p.amount_usd) : "") + (p.income_qualified ? " [income-qualified]" : ""));
        if (p.apply_url) L.push("      apply: " + p.apply_url);
      });
    }
    if (j.rooms && j.rooms.length) {
      L.push("");
      L.push("ROOM AIRFLOW");
      j.rooms.forEach(function (x) {
        L.push("  - " + x.name + ": " + fmt(x.required_cfm) + " CFM needed" + (x.actual_cfm != null ? ", " + fmt(x.actual_cfm) + " now" : ""));
      });
    }
    L.push("");
    L.push(j.disclaimer);
    return L.join("\n");
  }

  /*
   * POST to an automation the shop owns. Deliberately NOT ServiceTitan's API:
   * their credentials belong on a server under the shop's own app
   * registration, and handing an App Key to this app is the tunneling pattern
   * ServiceTitan prohibits outright.
   *
   * no-cors is not used: a silent opaque success would be worse than an
   * honest CORS failure, because the rep would believe the job was sent.
   */
  function sendWebhook(url, ctx, fetchImpl) {
    var f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!f) return Promise.reject(new Error("No network available."));
    if (!/^https:\/\/[^\s]+$/i.test(String(url || ""))) {
      return Promise.reject(new Error("Enter an https:// webhook URL in Settings first."));
    }
    var payload = toJson(ctx);
    if (!payload) return Promise.reject(new Error("Run a load calculation first."));
    return f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) throw new Error("The webhook replied " + r.status + ". Check the URL in Settings.");
      return { ok: true, status: r.status };
    }, function () {
      // A browser POST to another origin needs that origin to allow it.
      throw new Error("Couldn't reach the webhook. Zapier, Make and n8n accept browser posts; a custom endpoint needs to allow CORS from this site.");
    });
  }

  function fileName(ctx) {
    var g = (ctx && ctx.geo) || {};
    var base = (g.label || "load-calc").split(",")[0].replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
    return "loadmaster-" + (base || "job") + "-" + new Date().toISOString().slice(0, 10) + ".json";
  }

  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    toJson: toJson, toText: toText, sendWebhook: sendWebhook, fileName: fileName
  };
  root.JobExport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
