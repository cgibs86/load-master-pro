import { useMemo, useState } from "react";
import { Flame, Snowflake, Wind, Home, Sun, Users } from "lucide-react";
import { calculateLoads, type LoadInputs } from "@/lib/hvac";
import {
  CLIMATE_PRESETS,
  CONSTRUCTION_PRESETS,
  DEFAULT_INPUTS,
} from "@/lib/presets";
import { Field } from "@/components/Field";
import { Breakdown } from "@/components/Breakdown";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function App() {
  const [input, setInput] = useState<LoadInputs>(DEFAULT_INPUTS);

  const set = <K extends keyof LoadInputs>(key: K) => (value: LoadInputs[K]) =>
    setInput((prev) => ({ ...prev, [key]: value }));

  const results = useMemo(() => calculateLoads(input), [input]);

  const applyClimate = (id: string) => {
    const p = CLIMATE_PRESETS.find((c) => c.id === id);
    if (!p) return;
    setInput((prev) => ({
      ...prev,
      outdoorWinter: p.outdoorWinter,
      outdoorSummer: p.outdoorSummer,
      grainsDifference: p.grainsDifference,
      solarGainPerSqft: p.solarGainPerSqft,
    }));
  };

  const applyConstruction = (id: string) => {
    const p = CONSTRUCTION_PRESETS.find((c) => c.id === id);
    if (!p) return;
    setInput((prev) => ({
      ...prev,
      wallR: p.wallR,
      ceilingR: p.ceilingR,
      floorR: p.floorR,
      doorR: p.doorR,
      windowU: p.windowU,
      windowSHGC: p.windowSHGC,
      ach: p.ach,
    }));
  };

  const h = results.heating;
  const c = results.cooling;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Load Master <span className="text-brand">Pro</span>
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          Residential HVAC heating &amp; cooling load estimator using a simplified
          Manual J method. Adjust the building inputs and design conditions to see
          loads update live.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.3fr,1fr]">
        {/* ---- Inputs ---- */}
        <div className="space-y-6">
          <Section title="Design Conditions" icon={<Wind size={16} />}>
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Climate preset</span>
                <select
                  onChange={(e) => applyClimate(e.target.value)}
                  defaultValue=""
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
                >
                  <option value="" disabled>
                    Choose a region…
                  </option>
                  {CLIMATE_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-700">Construction preset</span>
                <select
                  onChange={(e) => applyConstruction(e.target.value)}
                  defaultValue=""
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
                >
                  <option value="" disabled>
                    Choose a vintage…
                  </option>
                  {CONSTRUCTION_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Indoor heating setpoint" unit="°F" value={input.indoorWinter} onChange={set("indoorWinter")} />
              <Field label="Indoor cooling setpoint" unit="°F" value={input.indoorSummer} onChange={set("indoorSummer")} />
              <Field label="Outdoor winter design" unit="°F" step={1} min={-40} value={input.outdoorWinter} onChange={set("outdoorWinter")} />
              <Field label="Outdoor summer design" unit="°F" value={input.outdoorSummer} onChange={set("outdoorSummer")} />
            </div>
          </Section>

          <Section title="Geometry" icon={<Home size={16} />}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Conditioned floor area" unit="ft²" step={50} value={input.floorArea} onChange={set("floorArea")} />
              <Field label="Avg. ceiling height" unit="ft" step={0.5} value={input.ceilingHeight} onChange={set("ceilingHeight")} />
              <Field label="Gross exterior wall area" unit="ft²" step={50} value={input.wallArea} onChange={set("wallArea")} />
              <Field label="Window / glazing area" unit="ft²" step={10} value={input.windowArea} onChange={set("windowArea")} />
              <Field label="Exterior door area" unit="ft²" step={5} value={input.doorArea} onChange={set("doorArea")} />
            </div>
          </Section>

          <Section title="Envelope & Air Leakage" icon={<Snowflake size={16} />}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Wall R-value" unit="h·ft²·°F/BTU" value={input.wallR} onChange={set("wallR")} />
              <Field label="Ceiling / roof R-value" unit="h·ft²·°F/BTU" value={input.ceilingR} onChange={set("ceilingR")} />
              <Field label="Floor R-value" unit="h·ft²·°F/BTU" value={input.floorR} onChange={set("floorR")} />
              <Field label="Door R-value" unit="h·ft²·°F/BTU" value={input.doorR} onChange={set("doorR")} />
              <Field label="Window U-factor" unit="BTU/h·ft²·°F" step={0.05} value={input.windowU} onChange={set("windowU")} />
              <Field label="Window SHGC" unit="0–1" step={0.05} value={input.windowSHGC} onChange={set("windowSHGC")} hint="Solar heat gain coefficient" />
              <Field label="Air changes per hour" unit="ACH" step={0.05} value={input.ach} onChange={set("ach")} />
            </div>
          </Section>

          <Section title="Internal & Solar Gains" icon={<Sun size={16} />}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Occupants" unit="people" value={input.occupants} onChange={set("occupants")} />
              <Field label="Appliance + lighting" unit="watts" step={100} value={input.applianceWatts} onChange={set("applianceWatts")} />
              <Field label="Peak solar gain" unit="BTU/h·ft²" step={10} value={input.solarGainPerSqft} onChange={set("solarGainPerSqft")} hint="Effective average per ft² of glazing" />
              <Field label="Moisture difference" unit="grains/lb" value={input.grainsDifference} onChange={set("grainsDifference")} hint="Outdoor − indoor humidity" />
            </div>
          </Section>
        </div>

        {/* ---- Results ---- */}
        <div className="space-y-6 lg:sticky lg:top-8 lg:self-start">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-2xl border border-orange-200 bg-orange-50 p-5">
              <div className="flex items-center gap-2 text-heat">
                <Flame size={18} />
                <span className="text-sm font-semibold">Heating</span>
              </div>
              <p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">
                {fmt(h.total)}
              </p>
              <p className="text-xs text-slate-500">BTU/h</p>
            </div>
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <div className="flex items-center gap-2 text-cool">
                <Snowflake size={18} />
                <span className="text-sm font-semibold">Cooling</span>
              </div>
              <p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">
                {fmt(c.total)}
              </p>
              <p className="text-xs text-slate-500">
                BTU/h &middot; {c.tons.toFixed(1)} tons
              </p>
            </div>
          </div>

          <Section title="Heating Breakdown" icon={<Flame size={16} className="text-heat" />}>
            <Breakdown
              accent="bg-heat"
              segments={[
                { label: "Walls", value: h.breakdown.walls },
                { label: "Windows", value: h.breakdown.windows },
                { label: "Doors", value: h.breakdown.doors },
                { label: "Ceiling / roof", value: h.breakdown.ceiling },
                { label: "Floor", value: h.breakdown.floor },
                { label: "Infiltration", value: h.breakdown.infiltration },
              ]}
            />
          </Section>

          <Section title="Cooling Breakdown" icon={<Snowflake size={16} className="text-cool" />}>
            <div className="mb-3 flex gap-4 text-xs text-slate-500">
              <span>
                Sensible <strong className="text-slate-800">{fmt(c.sensible)}</strong> BTU/h
              </span>
              <span>
                Latent <strong className="text-slate-800">{fmt(c.latent)}</strong> BTU/h
              </span>
            </div>
            <Breakdown
              accent="bg-cool"
              segments={[
                { label: "Solar (windows)", value: c.breakdown.solar ?? 0 },
                { label: "Walls", value: c.breakdown.walls },
                { label: "Windows (conduction)", value: c.breakdown.windows },
                { label: "Doors", value: c.breakdown.doors },
                { label: "Ceiling / roof", value: c.breakdown.ceiling },
                { label: "Floor", value: c.breakdown.floor },
                { label: "Infiltration (sensible)", value: c.breakdown.infiltration },
                { label: "Occupants (sensible)", value: c.breakdown.occupants ?? 0 },
                { label: "Appliances / lighting", value: c.breakdown.appliances ?? 0 },
                { label: "Infiltration (latent)", value: c.breakdown.latentInfiltration },
                { label: "Occupants (latent)", value: c.breakdown.latentOccupants },
              ]}
            />
            <p className="mt-4 flex items-center gap-2 text-xs text-slate-400">
              <Users size={12} />
              Sizing estimate only — confirm with a full Manual J before equipment selection.
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}
