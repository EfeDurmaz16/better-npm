// crates/better-core/src/ai/provision.rs
// AI-assisted OSP service selection and provisioning guidance

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct ProvisionRecommendation {
    pub service_type: String,
    pub recommended: Vec<ServiceOption>,
    pub reasoning: String,
    pub auto_provision_cmd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceOption {
    pub provider: String,
    pub service: String,
    pub tier: String,
    pub monthly_cost_usd: f64,
    pub features: Vec<String>,
    pub osp_supported: bool,
}

/// Analyze project and recommend services based on detected needs.
pub fn recommend_services(project_root: &Path) -> Result<Vec<ProvisionRecommendation>, String> {
    let needs = detect_service_needs(project_root)?;
    let mut recommendations = vec![];

    for need in &needs {
        let rec = match need.as_str() {
            "database" => ProvisionRecommendation {
                service_type: "database".to_string(),
                recommended: vec![
                    ServiceOption {
                        provider: "Sardis".to_string(),
                        service: "PostgreSQL".to_string(),
                        tier: "starter".to_string(),
                        monthly_cost_usd: 0.0,
                        features: vec!["5GB storage".to_string(), "Auto-backups".to_string()],
                        osp_supported: true,
                    },
                    ServiceOption {
                        provider: "PlanetScale".to_string(),
                        service: "MySQL".to_string(),
                        tier: "hobby".to_string(),
                        monthly_cost_usd: 0.0,
                        features: vec!["5GB storage".to_string(), "Branching".to_string()],
                        osp_supported: false,
                    },
                ],
                reasoning: "Project uses database patterns (ORM imports detected)".to_string(),
                auto_provision_cmd: Some("better provision database/postgresql --tier starter --pay sardis".to_string()),
            },
            "cache" => ProvisionRecommendation {
                service_type: "cache".to_string(),
                recommended: vec![
                    ServiceOption {
                        provider: "Sardis".to_string(),
                        service: "Redis".to_string(),
                        tier: "starter".to_string(),
                        monthly_cost_usd: 0.0,
                        features: vec!["25MB".to_string(), "Pub/Sub".to_string()],
                        osp_supported: true,
                    },
                ],
                reasoning: "Project uses cache patterns (redis/ioredis detected)".to_string(),
                auto_provision_cmd: Some("better provision cache/redis --tier starter --pay sardis".to_string()),
            },
            "storage" => ProvisionRecommendation {
                service_type: "storage".to_string(),
                recommended: vec![
                    ServiceOption {
                        provider: "Cloudflare R2".to_string(),
                        service: "Object Storage".to_string(),
                        tier: "free".to_string(),
                        monthly_cost_usd: 0.0,
                        features: vec!["10GB free".to_string(), "S3-compatible".to_string()],
                        osp_supported: false,
                    },
                ],
                reasoning: "Project uses storage/file upload patterns".to_string(),
                auto_provision_cmd: None,
            },
            "email" => ProvisionRecommendation {
                service_type: "email".to_string(),
                recommended: vec![
                    ServiceOption {
                        provider: "Resend".to_string(),
                        service: "Email API".to_string(),
                        tier: "free".to_string(),
                        monthly_cost_usd: 0.0,
                        features: vec!["3000 emails/month".to_string(), "React Email support".to_string()],
                        osp_supported: false,
                    },
                ],
                reasoning: "Project uses email patterns (nodemailer/resend detected)".to_string(),
                auto_provision_cmd: None,
            },
            _ => continue,
        };
        recommendations.push(rec);
    }

    Ok(recommendations)
}

fn detect_service_needs(project_root: &Path) -> Result<Vec<String>, String> {
    let mut needs = vec![];

    // Check package.json dependencies for known service indicators
    let pkg_path = project_root.join("package.json");
    if let Ok(content) = std::fs::read_to_string(&pkg_path) {
        if content.contains("\"pg\"") || content.contains("\"prisma\"") ||
           content.contains("\"typeorm\"") || content.contains("\"sequelize\"") ||
           content.contains("\"mongoose\"") || content.contains("\"drizzle-orm\"") {
            needs.push("database".to_string());
        }
        if content.contains("\"redis\"") || content.contains("\"ioredis\"") ||
           content.contains("\"@upstash/redis\"") {
            needs.push("cache".to_string());
        }
        if content.contains("\"multer\"") || content.contains("\"aws-sdk\"") ||
           content.contains("\"@aws-sdk/client-s3\"") || content.contains("\"minio\"") {
            needs.push("storage".to_string());
        }
        if content.contains("\"nodemailer\"") || content.contains("\"resend\"") ||
           content.contains("\"sendgrid\"") || content.contains("\"@sendgrid/mail\"") {
            needs.push("email".to_string());
        }
    }

    Ok(needs)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_pkg_json(root: &std::path::Path, content: &str) {
        std::fs::create_dir_all(root).unwrap();
        let mut f = std::fs::File::create(root.join("package.json")).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn no_dependencies_no_recommendations() {
        let tmp = std::env::temp_dir().join("provision-test-empty");
        write_pkg_json(&tmp, r#"{"name":"app","version":"1.0.0","dependencies":{}}"#);
        let recs = recommend_services(&tmp).unwrap();
        assert!(recs.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn database_dep_suggests_db_service() {
        let tmp = std::env::temp_dir().join("provision-test-db");
        write_pkg_json(&tmp, r#"{"name":"app","version":"1.0.0","dependencies":{"pg":"^8.0.0"}}"#);
        let recs = recommend_services(&tmp).unwrap();
        assert!(recs.iter().any(|r| r.service_type == "database"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn redis_dep_suggests_cache_service() {
        let tmp = std::env::temp_dir().join("provision-test-cache");
        write_pkg_json(&tmp, r#"{"name":"app","version":"1.0.0","dependencies":{"redis":"^4.0.0"}}"#);
        let recs = recommend_services(&tmp).unwrap();
        assert!(recs.iter().any(|r| r.service_type == "cache"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_package_json_returns_empty() {
        // When package.json is absent, detect_service_needs returns Ok([])
        let result = recommend_services(std::path::Path::new("/nonexistent-provision-project"));
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }
}
