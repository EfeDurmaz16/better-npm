use super::manifest::{parse_dependency_string, MarkerEnvironment, PyDependency};
use super::pypi::PypiPackageInfo;
use super::specifier::VersionConstraint;
use super::version::Pep440Version;
use super::wheel::{select_best_wheel, select_sdist, PlatformTags};
use std::collections::HashMap;
use std::time::Instant;

/// A resolved package with its version, dependencies, and download info.
#[derive(Debug, Clone)]
pub struct ResolvedPackage {
    pub name: String,
    pub version: Pep440Version,
    pub dependencies: Vec<PyDependency>,
    pub extras: Vec<String>,
    pub download_url: String,
    pub sha256: String,
}

/// Result of a successful dependency resolution.
#[derive(Debug)]
pub struct ResolutionResult {
    pub packages: Vec<ResolvedPackage>,
    pub resolution_ms: u64,
    pub backtracks: u32,
}

/// Errors that can occur during resolution.
#[derive(Debug)]
pub enum ResolutionError {
    Conflict {
        package: String,
        constraint_a: String,
        constraint_b: String,
    },
    NotFound {
        package: String,
    },
    Network {
        message: String,
    },
    MaxBacktracks {
        count: u32,
    },
}

/// Backtracking dependency resolver for Python packages.
pub struct Resolver {
    env: MarkerEnvironment,
    platform: PlatformTags,
    cache: HashMap<String, PypiPackageInfo>,
    deps_cache: HashMap<(String, String), Vec<String>>,
    max_backtracks: u32,
}

/// A decision made during resolution (for backtracking).
#[derive(Debug, Clone)]
struct Decision {
    package: String,
    version: Pep440Version,
    /// Index into the sorted candidates list (next to try on backtrack)
    candidate_index: usize,
}

impl Resolver {
    pub fn new(env: MarkerEnvironment) -> Self {
        let python_version = env.python_full_version.clone();
        Self {
            env,
            platform: PlatformTags::detect(&python_version),
            cache: HashMap::new(),
            deps_cache: HashMap::new(),
            max_backtracks: 10_000,
        }
    }

    /// Resolve a set of top-level dependencies into a flat package list.
    pub fn resolve(&mut self, deps: &[PyDependency]) -> Result<ResolutionResult, ResolutionError> {
        let start = Instant::now();
        let mut backtracks = 0u32;

        // Constraint map: package_name -> merged constraint
        let mut constraints: HashMap<String, VersionConstraint> = HashMap::new();
        // Decision stack for backtracking
        let mut decisions: Vec<Decision> = Vec::new();
        // Resolved packages: name -> ResolvedPackage
        let mut resolved: HashMap<String, ResolvedPackage> = HashMap::new();
        // Queue of packages to resolve
        let mut queue: Vec<PyDependency> = Vec::new();

        // Initialize with top-level dependencies (filtered by markers)
        for dep in deps {
            if !self.markers_match(dep) {
                continue;
            }
            self.merge_constraint(&mut constraints, &dep.name, &dep.constraint);
            queue.push(dep.clone());
        }

        while let Some(dep) = queue.pop() {
            let name = &dep.name;

            // Already resolved?
            if let Some(existing) = resolved.get(name) {
                // Check if existing version satisfies the new constraint
                if let Some(constraint) = constraints.get(name) {
                    if constraint.matches(&existing.version) {
                        continue; // Compatible, skip
                    }
                    // Conflict: need to backtrack
                    backtracks += 1;
                    if backtracks > self.max_backtracks {
                        return Err(ResolutionError::MaxBacktracks {
                            count: self.max_backtracks,
                        });
                    }

                    // Simple backtrack: remove the conflicting package and re-resolve
                    // with the merged constraint
                    resolved.remove(name);
                    // Remove from decisions
                    decisions.retain(|d| d.package != *name);
                    // Re-queue
                    queue.push(dep);
                    continue;
                }
            }

            // Fetch available versions from PyPI
            let info = self.get_package_info(name)?;
            let constraint = constraints.get(name).cloned().unwrap_or_else(|| {
                VersionConstraint {
                    specifiers: Vec::new(),
                }
            });

            // Filter and sort candidates (highest first)
            let mut candidates: Vec<&Pep440Version> = info
                .versions
                .iter()
                .filter(|v| {
                    // Filter by constraint
                    constraint.matches(v)
                    // Skip pre-releases unless explicitly requested
                    && !v.is_prerelease()
                })
                .collect();
            candidates.sort();
            candidates.reverse(); // Highest first

            // If no stable candidates, try pre-releases
            if candidates.is_empty() {
                candidates = info
                    .versions
                    .iter()
                    .filter(|v| constraint.matches(v))
                    .collect();
                candidates.sort();
                candidates.reverse();
            }

            if candidates.is_empty() {
                return Err(ResolutionError::NotFound {
                    package: name.clone(),
                });
            }

            // Pick the highest matching version
            let decision_idx = decisions
                .iter()
                .find(|d| d.package == *name)
                .map(|d| d.candidate_index)
                .unwrap_or(0);

            if decision_idx >= candidates.len() {
                return Err(ResolutionError::Conflict {
                    package: name.clone(),
                    constraint_a: format!("{:?}", constraint),
                    constraint_b: "no compatible version found".to_string(),
                });
            }

            let chosen_version = candidates[decision_idx].clone();

            // Find download URL for this version
            let version_str = chosen_version.normalize();
            let (download_url, sha256) = self.find_download_url(name, &version_str)?;

            // Fetch transitive dependencies
            let trans_deps = self.get_requires_dist(name, &version_str)?;

            let mut parsed_deps = Vec::new();
            for dep_str in &trans_deps {
                match parse_dependency_string(dep_str) {
                    Ok(d) => {
                        if self.markers_match(&d) {
                            parsed_deps.push(d);
                        }
                    }
                    Err(_) => continue,
                }
            }

            // Record decision
            decisions.push(Decision {
                package: name.clone(),
                version: chosen_version.clone(),
                candidate_index: decision_idx,
            });

            // Record resolution
            resolved.insert(
                name.clone(),
                ResolvedPackage {
                    name: name.clone(),
                    version: chosen_version,
                    dependencies: parsed_deps.clone(),
                    extras: dep.extras.clone(),
                    download_url,
                    sha256,
                },
            );

            // Queue transitive dependencies
            for trans_dep in &parsed_deps {
                self.merge_constraint(&mut constraints, &trans_dep.name, &trans_dep.constraint);
                if !resolved.contains_key(&trans_dep.name) {
                    queue.push(trans_dep.clone());
                }
            }
        }

        let packages: Vec<ResolvedPackage> = resolved.into_values().collect();
        let elapsed = start.elapsed().as_millis() as u64;

        Ok(ResolutionResult {
            packages,
            resolution_ms: elapsed,
            backtracks,
        })
    }

    /// Check if a dependency's markers match the current environment.
    fn markers_match(&self, dep: &PyDependency) -> bool {
        match &dep.markers {
            None => true,
            Some(markers) => markers.evaluate(&self.env),
        }
    }

    /// Merge a new constraint into the constraint map.
    fn merge_constraint(
        &self,
        constraints: &mut HashMap<String, VersionConstraint>,
        name: &str,
        new_constraint: &VersionConstraint,
    ) {
        if new_constraint.is_empty() {
            return;
        }
        let entry = constraints
            .entry(name.to_string())
            .or_insert_with(|| VersionConstraint {
                specifiers: Vec::new(),
            });
        entry.specifiers.extend(new_constraint.specifiers.clone());
    }

    /// Fetch and cache package info from PyPI.
    fn get_package_info(&mut self, name: &str) -> Result<&PypiPackageInfo, ResolutionError> {
        if !self.cache.contains_key(name) {
            let info = super::pypi::fetch_package_info(name)
                .map_err(|e| ResolutionError::Network { message: e })?;
            self.cache.insert(name.to_string(), info);
        }
        Ok(self.cache.get(name).unwrap())
    }

    /// Find the best download URL for a specific version.
    fn find_download_url(
        &self,
        name: &str,
        version: &str,
    ) -> Result<(String, String), ResolutionError> {
        let info = self
            .cache
            .get(name)
            .ok_or_else(|| ResolutionError::NotFound {
                package: name.to_string(),
            })?;

        let files = info.releases.get(version).ok_or_else(|| {
            ResolutionError::NotFound {
                package: format!("{}@{}", name, version),
            }
        })?;

        // Prefer wheel over sdist
        if let Some(wheel) = select_best_wheel(files, &self.platform) {
            return Ok((wheel.url.clone(), wheel.digests.sha256.clone()));
        }

        // Fall back to sdist
        if let Some(sdist) = select_sdist(files) {
            return Ok((sdist.url.clone(), sdist.digests.sha256.clone()));
        }

        Err(ResolutionError::NotFound {
            package: format!("{}@{} (no compatible files)", name, version),
        })
    }

    /// Get requires_dist for a specific package version.
    fn get_requires_dist(
        &mut self,
        name: &str,
        version: &str,
    ) -> Result<Vec<String>, ResolutionError> {
        let key = (name.to_string(), version.to_string());
        if let Some(cached) = self.deps_cache.get(&key) {
            return Ok(cached.clone());
        }

        let deps = super::pypi::get_requires_dist(name, version)
            .map_err(|e| ResolutionError::Network { message: e })?;

        self.deps_cache.insert(key, deps.clone());
        Ok(deps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolver_creation() {
        let env = MarkerEnvironment::detect("3.12.1");
        let resolver = Resolver::new(env);
        assert_eq!(resolver.max_backtracks, 10_000);
        assert!(resolver.cache.is_empty());
    }

    #[test]
    fn test_merge_constraint() {
        let env = MarkerEnvironment::detect("3.12.1");
        let resolver = Resolver::new(env);
        let mut constraints: HashMap<String, VersionConstraint> = HashMap::new();

        let c1 = VersionConstraint::parse(">=1.0").unwrap();
        resolver.merge_constraint(&mut constraints, "flask", &c1);
        assert_eq!(constraints["flask"].specifiers.len(), 1);

        let c2 = VersionConstraint::parse("<3.0").unwrap();
        resolver.merge_constraint(&mut constraints, "flask", &c2);
        assert_eq!(constraints["flask"].specifiers.len(), 2);
    }

    #[test]
    fn test_markers_match() {
        let env = MarkerEnvironment::detect("3.12.1");
        let resolver = Resolver::new(env);

        // No markers -> matches
        let dep = PyDependency {
            name: "test".to_string(),
            extras: Vec::new(),
            constraint: VersionConstraint::parse(">=1.0").unwrap(),
            markers: None,
        };
        assert!(resolver.markers_match(&dep));
    }
}
