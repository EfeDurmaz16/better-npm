use super::SearchPackage;

pub fn rank(packages: &mut [SearchPackage], query: &str) {
    let query_lower = query.to_lowercase();
    for pkg in packages.iter_mut() {
        pkg.score = compute_score(pkg, &query_lower);
    }
    packages.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn compute_score(pkg: &SearchPackage, query: &str) -> f64 {
    let mut score = 0.0;
    let name_lower = pkg.name.to_lowercase();

    // Name relevance (0 - 0.30)
    if name_lower == query {
        score += 0.30;
    } else if name_lower.starts_with(query) {
        score += 0.20;
    } else if name_lower.contains(query) {
        score += 0.10;
    }

    // Popularity via downloads (0 - 0.25, log-scaled)
    let pop = (pkg.downloads_weekly as f64 + 1.0).log10() / 10.0;
    score += pop.min(0.25);

    // Maintenance freshness (0 - 0.10)
    if !pkg.last_publish.is_empty() {
        score += 0.10; // Present = bonus
    }

    // Type safety (0 - 0.05)
    if pkg.has_types {
        score += 0.05;
    }

    // Keyword match (0 - 0.10)
    for keyword in &pkg.keywords {
        if keyword.to_lowercase().contains(query) {
            score += 0.05;
            break;
        }
    }

    // Description match (0 - 0.05)
    if pkg
        .description
        .to_lowercase()
        .contains(query)
    {
        score += 0.05;
    }

    // License present (0 - 0.05)
    if pkg.license.is_some() {
        score += 0.05;
    }

    // Multiple maintainers (0 - 0.05)
    if pkg.maintainers > 1 {
        score += 0.05;
    }

    score.min(1.0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::SearchPackage;

    fn pkg(name: &str, downloads: u64) -> SearchPackage {
        SearchPackage {
            name: name.to_string(),
            ecosystem: "npm".to_string(),
            version: "1.0.0".to_string(),
            description: "test package".to_string(),
            score: 0.0,
            downloads_weekly: downloads,
            last_publish: "2024-01-01".to_string(),
            license: Some("MIT".to_string()),
            maintainers: 1,
            has_types: false,
            keywords: vec![],
        }
    }

    #[test]
    fn exact_name_match_ranks_highest() {
        let mut pkgs = vec![pkg("lodash-utils", 1_000_000), pkg("lodash", 100)];
        rank(&mut pkgs, "lodash");
        assert_eq!(pkgs[0].name, "lodash");
    }

    #[test]
    fn high_downloads_boosts_score() {
        let mut pkgs = vec![pkg("foo", 100), pkg("bar", 10_000_000)];
        rank(&mut pkgs, "xyz"); // no name match
        assert!(pkgs[0].score >= pkgs[1].score);
        assert_eq!(pkgs[0].name, "bar");
    }

    #[test]
    fn rank_sets_scores_on_all_packages() {
        let mut pkgs = vec![pkg("a", 100), pkg("b", 200)];
        rank(&mut pkgs, "test");
        for p in &pkgs {
            assert!(p.score >= 0.0);
        }
    }
}
