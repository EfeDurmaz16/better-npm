/**
 * Finish both native phases before the caller publishes a lazy manifest.
 * Native methods can return a structured failure or throw; neither is success.
 */
export async function prepareLazyInstall(addon, lockfilePath, cacheRoot, fetchOptions) {
  const resolved = await addon.resolve(lockfilePath);
  if (resolved?.ok !== true || !Array.isArray(resolved.packages)) {
    throw new Error(`Lazy resolution failed: ${resolved?.reason ?? "invalid native result"}`);
  }

  const fetched = await addon.fetchAndExtract(lockfilePath, cacheRoot, fetchOptions);
  if (fetched?.ok !== true) {
    throw new Error(`Lazy fetch failed: ${fetched?.reason ?? "invalid native result"}`);
  }
  return { packages: resolved.packages, fetchedCount: fetched.packagesFetched ?? 0 };
}
