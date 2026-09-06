export function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** power;
  return `${scaled.toFixed(power === 0 ? 0 : scaled < 10 ? 1 : 0)} ${units[power]}`;
}

export function rate(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${bytes(bytesPerSecond)}/s` : "—";
}

export function percent(fraction: number): string {
  return `${Math.min(100, Math.max(0, fraction * 100)).toFixed(fraction >= 0.999 ? 0 : 1)}%`;
}

export function ago(timestamp: number): string {
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  let chosen: [number, Intl.RelativeTimeFormatUnit] = steps[0];
  for (const step of steps) if (seconds >= step[0]) chosen = step;
  return formatter.format(-Math.round(seconds / chosen[0]), chosen[1]);
}

export function eta(remaining: number, bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "—";
  const seconds = remaining / bytesPerSecond;
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m left`;
  return `${(seconds / 3600).toFixed(1)}h left`;
}
