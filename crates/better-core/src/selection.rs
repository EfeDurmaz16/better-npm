use crate::ResolvedPackage;

/// npm marks packages used exclusively by dev dependency paths with `dev`.
/// Shared and devOptional packages remain available in production installs.
pub fn select_production_packages(
    packages: &[ResolvedPackage],
    production: bool,
) -> Vec<ResolvedPackage> {
    packages
        .iter()
        .filter(|pkg| !production || !pkg.selection.dev)
        .cloned()
        .collect()
}
