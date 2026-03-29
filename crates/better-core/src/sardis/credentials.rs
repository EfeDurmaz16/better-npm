use std::path::PathBuf;

/// Encrypted credential store path: ~/.better/sardis-session.enc
pub fn credentials_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".better")
        .join("sardis-session.json")
}

/// Store session to disk.
pub fn store_session(session: &super::auth::SardisSession) -> Result<(), std::io::Error> {
    let path = credentials_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(session)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    std::fs::write(&path, json)
}

/// Load session from disk.
pub fn load_session() -> Result<super::auth::SardisSession, super::auth::SardisError> {
    let path = credentials_path();
    if !path.exists() {
        return Err(super::auth::SardisError::NotAuthenticated);
    }

    let data = std::fs::read_to_string(&path)
        .map_err(|e| super::auth::SardisError::Network(e.to_string()))?;

    let session: super::auth::SardisSession = serde_json::from_str(&data)
        .map_err(|e| super::auth::SardisError::Network(e.to_string()))?;

    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_credentials_path_is_in_better_dir() {
        let path = credentials_path();
        let path_str = path.to_str().unwrap();
        assert!(path_str.contains(".better"));
        assert!(path_str.ends_with("sardis-session.json"));
    }
}
