interface FieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  step?: number;
  min?: number;
  hint?: string;
}

export function Field({ label, value, onChange, unit, step = 1, min = 0, hint }: FieldProps) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-sm font-medium text-slate-700">
        {label}
        {unit && <span className="text-xs font-normal text-slate-400">{unit}</span>}
      </span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        step={step}
        min={min}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/30"
      />
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}
