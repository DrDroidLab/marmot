export const usd = (n) =>
  n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
export const pct = (n) => `${Math.round(n * 100)}%`;
export const num = (n) => Math.round(n).toLocaleString("en-US");
export const tokens = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
export const mins = (n) =>
  n >= 1440 ? `${(n / 1440).toFixed(1)}d` : n >= 60 ? `${(n / 60).toFixed(1)}h` : `${Math.round(n)}m`;

const C = process.env.NO_COLOR || !process.stdout.isTTY ? null : {
  dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", green: "\x1b[32m",
};
export const dim = (s) => (C ? `${C.dim}${s}${C.reset}` : s);
export const bold = (s) => (C ? `${C.bold}${s}${C.reset}` : s);
export const warn = (s) => (C ? `${C.yellow}${s}${C.reset}` : s);
export const info = (s) => (C ? `${C.cyan}${s}${C.reset}` : s);
export const good = (s) => (C ? `${C.green}${s}${C.reset}` : s);
