// Keep unsupported guarantees explicit, including on cache/reuse paths.
export function assertInstallOptionSupport(engine, opts = {}) {
  if (opts.sandbox) {
    throw new Error("--sandbox is not supported for install: required script isolation is not fully enforced.");
  }
  for (const [key, flag] of [["verifyProvenance", "--verify-provenance"], ["requireProvenance", "--require-provenance"]]) {
    if (opts[key]) {
      throw new Error(`${flag} is not supported for install: cryptographic provenance verification is not implemented.`);
    }
  }
}
