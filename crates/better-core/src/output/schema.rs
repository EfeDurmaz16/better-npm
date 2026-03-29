/// Schema index listing all available schemas
pub fn schema_index() -> String {
    let schemas = vec![
        ("install", "https://better.sh/schema/v1/install.json"),
        ("audit", "https://better.sh/schema/v1/audit.json"),
        ("outdated", "https://better.sh/schema/v1/outdated.json"),
        ("why", "https://better.sh/schema/v1/why.json"),
        ("doctor", "https://better.sh/schema/v1/doctor.json"),
        ("license", "https://better.sh/schema/v1/license.json"),
        ("dedupe", "https://better.sh/schema/v1/dedupe.json"),
        ("cache", "https://better.sh/schema/v1/cache.json"),
        ("benchmark", "https://better.sh/schema/v1/benchmark.json"),
        ("env", "https://better.sh/schema/v1/env.json"),
        ("scripts", "https://better.sh/schema/v1/scripts.json"),
        ("policy", "https://better.sh/schema/v1/policy.json"),
        ("workspace", "https://better.sh/schema/v1/workspace.json"),
        ("sbom", "https://better.sh/schema/v1/sbom.json"),
        ("firewall", "https://better.sh/schema/v1/firewall.json"),
        ("provenance", "https://better.sh/schema/v1/provenance.json"),
        ("registry", "https://better.sh/schema/v1/registry.json"),
    ];

    let mut json = String::from("{\"schemas\":{");
    for (i, (name, url)) in schemas.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        json.push_str(&format!("\"{}\":\"{}\"", name, url));
    }
    json.push_str("}}");
    json
}
