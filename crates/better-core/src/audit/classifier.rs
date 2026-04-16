use super::scoring::DepContext;
use std::collections::{HashMap, HashSet};

/// Classifies every dependency in the graph by its context.
pub struct DepClassifier {
    /// package_key ("name@version") -> DepContext
    pub classifications: HashMap<String, DepContext>,
}

/// Build tool package name patterns that indicate build-only deps.
const BUILD_PATTERNS: &[&str] = &[
    "webpack", "rollup", "esbuild", "vite", "parcel", "swc",
    "babel", "postcss", "autoprefixer", "tailwindcss",
    "tsup", "unbuild", "turbo",
];

impl DepClassifier {
    /// Classify all packages in the dependency graph.
    ///
    /// - `root_deps`: name -> version range from package.json `dependencies`
    /// - `root_dev_deps`: name -> version range from `devDependencies`
    /// - `root_optional_deps`: name -> version range from `optionalDependencies`
    /// - `dep_graph`: adjacency list — package_key -> Vec<child_package_key>
    /// - `resolved_versions`: package name -> resolved version
    pub fn classify(
        root_deps: &HashMap<String, String>,
        root_dev_deps: &HashMap<String, String>,
        root_optional_deps: &HashMap<String, String>,
        dep_graph: &HashMap<String, Vec<String>>,
        resolved_versions: &HashMap<String, String>,
    ) -> Self {
        let mut classifications = HashMap::new();

        // Step 1: Classify direct deps
        for (name, _) in root_deps {
            let key = format!(
                "{}@{}",
                name,
                resolved_versions.get(name).unwrap_or(&"*".to_string())
            );
            let ctx = if is_build_dep(name) {
                DepContext::Build
            } else {
                DepContext::Production
            };
            classifications.insert(key, ctx);
        }

        for (name, _) in root_optional_deps {
            let key = format!(
                "{}@{}",
                name,
                resolved_versions.get(name).unwrap_or(&"*".to_string())
            );
            classifications.entry(key).or_insert(DepContext::Optional);
        }

        for (name, _) in root_dev_deps {
            let key = format!(
                "{}@{}",
                name,
                resolved_versions.get(name).unwrap_or(&"*".to_string())
            );
            classifications.entry(key).or_insert(DepContext::Dev);
        }

        // Step 2: BFS to classify transitive deps
        let mut queue: Vec<String> = classifications.keys().cloned().collect();
        let mut visited: HashSet<String> = queue.iter().cloned().collect();

        while let Some(parent_key) = queue.pop() {
            let parent_ctx = *classifications
                .get(&parent_key)
                .unwrap_or(&DepContext::Transitive);

            if let Some(children) = dep_graph.get(&parent_key) {
                for child_key in children {
                    let inherited = inherit_context(parent_ctx);
                    let effective = match classifications.get(child_key) {
                        Some(&existing) => higher_priority(existing, inherited),
                        None => inherited,
                    };
                    classifications.insert(child_key.clone(), effective);

                    if visited.insert(child_key.clone()) {
                        queue.push(child_key.clone());
                    }
                }
            }
        }

        Self { classifications }
    }

    pub fn get(&self, package_key: &str) -> DepContext {
        *self
            .classifications
            .get(package_key)
            .unwrap_or(&DepContext::Transitive)
    }
}

fn is_build_dep(name: &str) -> bool {
    BUILD_PATTERNS.iter().any(|pat| name.starts_with(pat))
}

/// Child of a prod dep is Transitive (still matters).
/// Child of a dev dep is Dev (doesn't matter in prod).
fn inherit_context(parent: DepContext) -> DepContext {
    match parent {
        DepContext::Production => DepContext::Transitive,
        DepContext::Dev => DepContext::Dev,
        DepContext::Build => DepContext::Build,
        DepContext::Optional => DepContext::Transitive,
        DepContext::Transitive => DepContext::Transitive,
    }
}

/// Return whichever context has higher priority for risk purposes.
/// Production > Transitive > Optional > Build > Dev
fn higher_priority(a: DepContext, b: DepContext) -> DepContext {
    let rank = |c: &DepContext| match c {
        DepContext::Production => 5,
        DepContext::Transitive => 4,
        DepContext::Optional => 3,
        DepContext::Build => 2,
        DepContext::Dev => 1,
    };
    if rank(&a) >= rank(&b) { a } else { b }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_graph() -> (
        HashMap<String, String>,
        HashMap<String, String>,
        HashMap<String, String>,
        HashMap<String, Vec<String>>,
        HashMap<String, String>,
    ) {
        let mut root_deps = HashMap::new();
        root_deps.insert("express".to_string(), "^4.18.0".to_string());

        let mut root_dev_deps = HashMap::new();
        root_dev_deps.insert("jest".to_string(), "^29.0.0".to_string());

        let root_optional_deps = HashMap::new();

        let mut dep_graph = HashMap::new();
        dep_graph.insert(
            "express@4.18.2".to_string(),
            vec!["body-parser@1.20.0".to_string()],
        );
        dep_graph.insert(
            "jest@29.7.0".to_string(),
            vec!["chalk@4.1.2".to_string()],
        );

        let mut resolved_versions = HashMap::new();
        resolved_versions.insert("express".to_string(), "4.18.2".to_string());
        resolved_versions.insert("jest".to_string(), "29.7.0".to_string());
        resolved_versions.insert("body-parser".to_string(), "1.20.0".to_string());
        resolved_versions.insert("chalk".to_string(), "4.1.2".to_string());

        (root_deps, root_dev_deps, root_optional_deps, dep_graph, resolved_versions)
    }

    #[test]
    fn direct_prod_dep_classified() {
        let (rd, rdd, rod, dg, rv) = make_graph();
        let c = DepClassifier::classify(&rd, &rdd, &rod, &dg, &rv);
        assert_eq!(c.get("express@4.18.2"), DepContext::Production);
    }

    #[test]
    fn transitive_of_dev_stays_dev() {
        let (rd, rdd, rod, dg, rv) = make_graph();
        let c = DepClassifier::classify(&rd, &rdd, &rod, &dg, &rv);
        assert_eq!(c.get("chalk@4.1.2"), DepContext::Dev);
    }

    #[test]
    fn transitive_of_prod_is_transitive() {
        let (rd, rdd, rod, dg, rv) = make_graph();
        let c = DepClassifier::classify(&rd, &rdd, &rod, &dg, &rv);
        assert_eq!(c.get("body-parser@1.20.0"), DepContext::Transitive);
    }

    #[test]
    fn multi_path_takes_highest() {
        let mut rd = HashMap::new();
        rd.insert("a".to_string(), "^1.0.0".to_string());

        let mut rdd = HashMap::new();
        rdd.insert("b".to_string(), "^1.0.0".to_string());

        let rod = HashMap::new();

        // shared@1.0.0 is transitive of both prod 'a' and dev 'b'
        let mut dg = HashMap::new();
        dg.insert("a@1.0.0".to_string(), vec!["shared@1.0.0".to_string()]);
        dg.insert("b@1.0.0".to_string(), vec!["shared@1.0.0".to_string()]);

        let mut rv = HashMap::new();
        rv.insert("a".to_string(), "1.0.0".to_string());
        rv.insert("b".to_string(), "1.0.0".to_string());
        rv.insert("shared".to_string(), "1.0.0".to_string());

        let c = DepClassifier::classify(&rd, &rdd, &rod, &dg, &rv);
        // Transitive (from prod path) > Dev (from dev path)
        assert_eq!(c.get("shared@1.0.0"), DepContext::Transitive);
    }

    #[test]
    fn build_tools_detected() {
        let mut rd = HashMap::new();
        rd.insert("webpack".to_string(), "^5.0.0".to_string());
        rd.insert("vite".to_string(), "^5.0.0".to_string());

        let rdd = HashMap::new();
        let rod = HashMap::new();
        let dg = HashMap::new();

        let mut rv = HashMap::new();
        rv.insert("webpack".to_string(), "5.90.0".to_string());
        rv.insert("vite".to_string(), "5.1.0".to_string());

        let c = DepClassifier::classify(&rd, &rdd, &rod, &dg, &rv);
        assert_eq!(c.get("webpack@5.90.0"), DepContext::Build);
        assert_eq!(c.get("vite@5.1.0"), DepContext::Build);
    }

    #[test]
    fn unclassified_package_defaults_to_transitive() {
        let c = DepClassifier::classify(
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );
        // Any unclassified package returns Transitive
        assert_eq!(c.get("unknown@1.0.0"), DepContext::Transitive);
    }

    #[test]
    fn higher_priority_production_wins_over_dev() {
        assert_eq!(
            higher_priority(DepContext::Production, DepContext::Dev),
            DepContext::Production
        );
        assert_eq!(
            higher_priority(DepContext::Dev, DepContext::Production),
            DepContext::Production
        );
    }

    #[test]
    fn is_build_dep_recognizes_esbuild_and_rollup() {
        assert!(is_build_dep("esbuild"));
        assert!(is_build_dep("rollup"));
        assert!(!is_build_dep("express"));
        assert!(!is_build_dep("lodash"));
    }
}
