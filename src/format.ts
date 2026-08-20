export function fmtCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const centsPart = abs % 100;
  const sign = neg ? "-" : "";
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(centsPart).padStart(2, "0")}`;
}

export function fmtHours(h: number): string {
  return h.toFixed(2);
}

export function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}