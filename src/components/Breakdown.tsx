interface Segment {
  label: string;
  value: number;
}

interface BreakdownProps {
  segments: Segment[];
  accent: string; // tailwind text color class for swatches, e.g. "bg-heat"
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** Horizontal proportional breakdown of load contributors. */
export function Breakdown({ segments, accent }: BreakdownProps) {
  const positive = segments.filter((s) => s.value > 0);
  const total = positive.reduce((sum, s) => sum + s.value, 0) || 1;

  return (
    <div className="space-y-2">
      {positive
        .slice()
        .sort((a, b) => b.value - a.value)
        .map((s) => {
          const pct = (s.value / total) * 100;
          return (
            <div key={s.label}>
              <div className="flex items-baseline justify-between text-xs text-slate-600">
                <span>{s.label}</span>
                <span className="tabular-nums">
                  {fmt(s.value)} BTU/h
                  <span className="ml-1 text-slate-400">({pct.toFixed(0)}%)</span>
                </span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className={`h-full rounded-full ${accent}`}
                  style={{ width: `${Math.max(2, pct)}%` }}
                />
              </div>
            </div>
          );
        })}
    </div>
  );
}
