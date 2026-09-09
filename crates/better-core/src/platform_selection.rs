use std::collections::{BTreeMap, BTreeSet, VecDeque};

use crate::{PackageSelection, ResolveResult, ResolvedPackage};

/// npm platform list semantics: a negation vetoes, positive lists require a match.
fn matches_platform(value: &str, list: &Option<Vec<String>>) -> bool {
    let Some(list) = list else { return true };
    if list.len() == 1 && list[0] == "any" { return true; }
    let mut positive = false;
    let mut matched = false;
    for item in list {
        if let Some(denied) = item.strip_prefix('!') {
            if denied == value { return false; }
        } else {
            positive = true;
            matched |= item == value;
        }
    }
    !positive || matched
}

pub fn validate_install_target(os: &str, cpu: &str) -> Result<(), String> {
    if !["darwin", "linux", "win32", "freebsd", "openbsd", "netbsd", "aix", "sunos", "android"].contains(&os) {
        return Err(format!("Unsupported install target OS '{}'", os));
    }
    if !["arm", "arm64", "ia32", "x64", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x"].contains(&cpu) {
        return Err(format!("Unsupported install target CPU '{}'", cpu));
    }
    Ok(())
}

pub fn native_install_target() -> (&'static str, &'static str) {
    let os = match std::env::consts::OS { "macos" => "darwin", "windows" => "win32", "solaris" => "sunos", other => other };
    let cpu = match std::env::consts::ARCH { "aarch64" => "arm64", "x86_64" => "x64", "x86" => "ia32", "powerpc" => "ppc", "powerpc64" => "ppc64", "loongarch64" => "loong64", other => other };
    (os, cpu)
}

#[derive(Clone)]
struct Edge { to: usize, optional: bool }

// Resolve against the exact lockfile layout, never choose a version by name.
fn lookup_target(from: &str, name: &str, peer: bool, locations: &BTreeMap<&str, usize>) -> Option<usize> {
    let mut context = from;
    if peer && !context.is_empty() {
        context = context.rsplit_once("/node_modules/").map(|(parent, _)| parent).unwrap_or("");
    }
    loop {
        let candidate = if context.is_empty() { format!("node_modules/{}", name) } else { format!("{}/node_modules/{}", context, name) };
        if let Some(index) = locations.get(candidate.as_str()) { return Some(*index); }
        if context.is_empty() { return None; }
        context = context.rsplit_once("/node_modules/").map(|(parent, _)| parent).unwrap_or("");
    }
}

fn edges_for(from: &str, metadata: &PackageSelection, root: bool, production: bool, locations: &BTreeMap<&str, usize>) -> Result<Vec<Edge>, String> {
    let mut declarations = BTreeMap::new();
    for name in metadata.dependencies.keys() { declarations.insert(name.as_str(), (false, false)); }
    if root && !production {
        for name in metadata.dev_dependencies.keys() { declarations.entry(name.as_str()).or_insert((false, false)); }
    }
    for name in metadata.optional_dependencies.keys() { declarations.insert(name.as_str(), (true, false)); }
    for name in metadata.peer_dependencies.keys() {
        let optional = metadata.peer_dependencies_meta.get(name).is_some_and(|m| m.optional);
        declarations.entry(name.as_str()).or_insert((optional, true));
    }
    let mut edges = Vec::new();
    for (name, (optional, peer)) in declarations {
        match lookup_target(from, name, peer, locations) {
            Some(to) => edges.push(Edge { to, optional }),
            None if optional => {},
            None => return Err(format!("Lockfile entry '{}' is missing required dependency '{}'", from, name)),
        }
    }
    Ok(edges)
}

/// Select before any fetching or tree mutation. Unsupported libc restrictions
/// fail explicitly until runtime libc detection is available.
pub fn select_platform_packages(resolved: &ResolveResult, production: bool, os: &str, cpu: &str) -> Result<Vec<ResolvedPackage>, String> {
    validate_install_target(os, cpu)?;
    if let Some(root) = &resolved.root_selection {
        if !matches_platform(os, &root.os) || !matches_platform(cpu, &root.cpu) {
            return Err(format!("Root package is incompatible with install target {}/{}", os, cpu));
        }
        if root.libc.is_some() {
            return Err("Native install does not support root libc restrictions; use npm install".to_string());
        }
    }
    let packages = crate::select_production_packages(&resolved.packages, production);
    let mut excluded = BTreeSet::new();
    for (index, package) in packages.iter().enumerate() {
        let metadata = &package.selection;
        if !matches_platform(os, &metadata.os) || !matches_platform(cpu, &metadata.cpu) {
            if !metadata.optional {
                return Err(format!("Required package '{}' is incompatible with install target {}/{}", package.rel_path, os, cpu));
            }
            excluded.insert(index);
        }
    }
    // Without exclusions retain exactly the locked package set, including legacy
    // fixtures without root edges. Graph pruning needs explicit root metadata.
    if excluded.is_empty() { return finish_selection(packages); }
    let root = resolved.root_selection.as_ref().ok_or_else(|| "Platform selection requires lockfile root package metadata".to_string())?;
    let locations: BTreeMap<_, _> = packages.iter().enumerate().map(|(i, p)| (p.rel_path.as_str(), i)).collect();
    let graph: Vec<_> = packages.iter().map(|p| edges_for(&p.rel_path, &p.selection, false, production, &locations)).collect::<Result<_, _>>()?;
    let root_edges = edges_for("", root, true, production, &locations)?;

    // A failing required child invalidates its optional parent, up to the first
    // optional edge. Never turn a required path into a partial successful install.
    loop {
        let mut changed = false;
        for (index, edges) in graph.iter().enumerate() {
            if !excluded.contains(&index) && edges.iter().any(|edge| !edge.optional && excluded.contains(&edge.to)) {
                if !packages[index].selection.optional {
                    return Err(format!("Required package '{}' depends on an excluded platform package", packages[index].rel_path));
                }
                excluded.insert(index);
                changed = true;
            }
        }
        if !changed { break; }
    }
    if root_edges.iter().any(|edge| !edge.optional && excluded.contains(&edge.to)) {
        return Err("Required root dependency was excluded by platform restrictions".to_string());
    }
    let mut reachable = BTreeSet::new();
    let mut queue: VecDeque<_> = root_edges.iter().map(|edge| edge.to).collect();
    while let Some(index) = queue.pop_front() {
        if excluded.contains(&index) || !reachable.insert(index) { continue; }
        queue.extend(graph[index].iter().map(|edge| edge.to));
    }
    finish_selection(packages.into_iter().enumerate().filter(|(index, _)| reachable.contains(index)).map(|(_, package)| package).collect())
}

fn finish_selection(packages: Vec<ResolvedPackage>) -> Result<Vec<ResolvedPackage>, String> {
    for package in &packages {
        if package.selection.libc.is_some() {
            return Err(format!("Native install does not support libc restrictions for '{}'; use npm install", package.rel_path));
        }
    }
    Ok(packages)
}
