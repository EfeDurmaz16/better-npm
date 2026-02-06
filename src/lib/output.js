export function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

export function printText(text) {
  process.stdout.write(`${text}\n`);
}

export function toErrorJson(err) {
  return {
    ok: false,
    error: {
      name: err?.name ?? "Error",
      message: err?.message ?? String(err),
      stack: err?.stack ?? null
    }
  };
}

