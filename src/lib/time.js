export function nowIso() {
  return new Date().toISOString();
}

export function msSince(startHrtime) {
  const diff = process.hrtime.bigint() - startHrtime;
  return Number(diff / 1_000_000n);
}

