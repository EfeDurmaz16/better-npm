use super::version::Pep440Version;

/// PEP 440 version comparison operator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionOp {
    Equal,        // ==
    NotEqual,     // !=
    LessThan,     // <
    LessEqual,    // <=
    GreaterThan,  // >
    GreaterEqual, // >=
    Compatible,   // ~=
    Arbitrary,    // ===
}

/// A single version specifier, e.g. `>=1.0` or `==1.4.*`.
#[derive(Debug, Clone)]
pub struct VersionSpecifier {
    pub op: VersionOp,
    pub version: Pep440Version,
    pub wildcard: bool, // for == 1.0.*
}

impl VersionSpecifier {
    /// Parse a single specifier like `>=1.0`, `==1.4.*`, `~=1.4.2`.
    pub fn parse(input: &str) -> Result<Self, String> {
        let input = input.trim();

        // Parse operator
        let (op, rest) = if input.starts_with("===") {
            (VersionOp::Arbitrary, input[3..].trim())
        } else if input.starts_with("==") {
            (VersionOp::Equal, input[2..].trim())
        } else if input.starts_with("!=") {
            (VersionOp::NotEqual, input[2..].trim())
        } else if input.starts_with("<=") {
            (VersionOp::LessEqual, input[2..].trim())
        } else if input.starts_with(">=") {
            (VersionOp::GreaterEqual, input[2..].trim())
        } else if input.starts_with("~=") {
            (VersionOp::Compatible, input[2..].trim())
        } else if input.starts_with('<') {
            (VersionOp::LessThan, input[1..].trim())
        } else if input.starts_with('>') {
            (VersionOp::GreaterThan, input[1..].trim())
        } else {
            // Bare version => ==
            (VersionOp::Equal, input)
        };

        // Check for wildcard
        let (version_str, wildcard) = if rest.ends_with(".*") {
            (&rest[..rest.len() - 2], true)
        } else {
            (rest, false)
        };

        let version = Pep440Version::parse(version_str)?;

        Ok(VersionSpecifier {
            op,
            version,
            wildcard,
        })
    }

    /// Check if a candidate version matches this specifier.
    pub fn matches(&self, candidate: &Pep440Version) -> bool {
        match self.op {
            VersionOp::Equal => {
                if self.wildcard {
                    // == 1.0.* matches any 1.0.x
                    self.wildcard_matches(candidate)
                } else {
                    candidate == &self.version
                }
            }
            VersionOp::NotEqual => {
                if self.wildcard {
                    !self.wildcard_matches(candidate)
                } else {
                    candidate != &self.version
                }
            }
            VersionOp::LessThan => candidate < &self.version,
            VersionOp::LessEqual => candidate <= &self.version,
            VersionOp::GreaterThan => candidate > &self.version,
            VersionOp::GreaterEqual => candidate >= &self.version,
            VersionOp::Compatible => {
                // ~=X.Y is equivalent to >=X.Y, ==X.*
                // ~=X.Y.Z is equivalent to >=X.Y.Z, ==X.Y.*
                self.compatible_matches(candidate)
            }
            VersionOp::Arbitrary => {
                // Exact string match (not normally used)
                candidate.normalize() == self.version.normalize()
            }
        }
    }

    /// Wildcard matching: == 1.0.* means release prefix matches.
    fn wildcard_matches(&self, candidate: &Pep440Version) -> bool {
        if candidate.epoch != self.version.epoch {
            return false;
        }
        // The specifier's release segments must be a prefix of the candidate's
        for (i, seg) in self.version.release.iter().enumerate() {
            match candidate.release.get(i) {
                Some(c) if c == seg => continue,
                _ => return false,
            }
        }
        true
    }

    /// Compatible release: ~=X.Y.Z means >=X.Y.Z, ==X.Y.*
    fn compatible_matches(&self, candidate: &Pep440Version) -> bool {
        // Must be >= the specified version
        if candidate < &self.version {
            return false;
        }
        // Must match the prefix (all but the last release segment)
        if candidate.epoch != self.version.epoch {
            return false;
        }
        if self.version.release.len() < 2 {
            // ~=X makes no sense; treat as >=X
            return true;
        }
        let prefix_len = self.version.release.len() - 1;
        for i in 0..prefix_len {
            let spec_seg = self.version.release.get(i).copied().unwrap_or(0);
            let cand_seg = candidate.release.get(i).copied().unwrap_or(0);
            if spec_seg != cand_seg {
                return false;
            }
        }
        true
    }
}

/// A set of specifiers combined with AND logic, e.g. `>=1.0,<2.0,!=1.3`.
#[derive(Debug, Clone)]
pub struct VersionConstraint {
    pub specifiers: Vec<VersionSpecifier>,
}

impl VersionConstraint {
    /// Parse a comma-separated list of specifiers.
    pub fn parse(input: &str) -> Result<Self, String> {
        let input = input.trim();
        if input.is_empty() {
            return Ok(VersionConstraint {
                specifiers: Vec::new(),
            });
        }

        let specifiers: Result<Vec<VersionSpecifier>, String> = input
            .split(',')
            .map(|s| VersionSpecifier::parse(s.trim()))
            .collect();

        Ok(VersionConstraint {
            specifiers: specifiers?,
        })
    }

    /// Check if a version satisfies all specifiers in this constraint.
    pub fn matches(&self, version: &Pep440Version) -> bool {
        self.specifiers.iter().all(|s| s.matches(version))
    }

    /// Whether this constraint has any specifiers.
    pub fn is_empty(&self) -> bool {
        self.specifiers.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_specifier_equal() {
        let s = VersionSpecifier::parse("==1.0").unwrap();
        assert!(s.matches(&Pep440Version::parse("1.0").unwrap()));
        assert!(s.matches(&Pep440Version::parse("1.0.0").unwrap()));
        assert!(!s.matches(&Pep440Version::parse("1.1").unwrap()));
    }

    #[test]
    fn test_specifier_wildcard() {
        let s = VersionSpecifier::parse("==1.0.*").unwrap();
        assert!(s.matches(&Pep440Version::parse("1.0.0").unwrap()));
        assert!(s.matches(&Pep440Version::parse("1.0.5").unwrap()));
        assert!(!s.matches(&Pep440Version::parse("1.1.0").unwrap()));
    }

    #[test]
    fn test_specifier_not_equal() {
        let s = VersionSpecifier::parse("!=1.5").unwrap();
        assert!(s.matches(&Pep440Version::parse("1.4").unwrap()));
        assert!(!s.matches(&Pep440Version::parse("1.5").unwrap()));
        assert!(!s.matches(&Pep440Version::parse("1.5.0").unwrap()));
    }

    #[test]
    fn test_specifier_less_than() {
        let s = VersionSpecifier::parse("<2.0").unwrap();
        assert!(s.matches(&Pep440Version::parse("1.9").unwrap()));
        assert!(!s.matches(&Pep440Version::parse("2.0").unwrap()));
        assert!(!s.matches(&Pep440Version::parse("2.1").unwrap()));
    }

    #[test]
    fn test_specifier_greater_equal() {
        let s = VersionSpecifier::parse(">=1.0").unwrap();
        assert!(s.matches(&Pep440Version::parse("1.0").unwrap()));
        assert!(s.matches(&Pep440Version::parse("2.0").unwrap()));
        assert!(!s.matches(&Pep440Version::parse("0.9").unwrap()));
    }

    #[test]
    fn test_specifier_compatible() {
        let s = VersionSpecifier::parse("~=1.4.2").unwrap();
        assert!(s.matches(&Pep440Version::parse("1.4.2").unwrap()));
        assert!(s.matches(&Pep440Version::parse("1.4.5").unwrap()));
        assert!(!s.matches(&Pep440Version::parse("1.5.0").unwrap()));
        assert!(!s.matches(&Pep440Version::parse("1.3.0").unwrap()));
    }

    #[test]
    fn test_constraint_combined() {
        let c = VersionConstraint::parse(">=1.0,<2.0,!=1.5").unwrap();
        assert!(c.matches(&Pep440Version::parse("1.3").unwrap()));
        assert!(!c.matches(&Pep440Version::parse("1.5").unwrap()));
        assert!(!c.matches(&Pep440Version::parse("2.1").unwrap()));
        assert!(!c.matches(&Pep440Version::parse("0.9").unwrap()));
    }

    #[test]
    fn test_constraint_empty() {
        let c = VersionConstraint::parse("").unwrap();
        assert!(c.matches(&Pep440Version::parse("1.0").unwrap()));
        assert!(c.is_empty());
    }

    #[test]
    fn test_compatible_two_segments() {
        let s = VersionSpecifier::parse("~=1.4").unwrap();
        assert!(s.matches(&Pep440Version::parse("1.4").unwrap()));
        assert!(s.matches(&Pep440Version::parse("1.9").unwrap()));
        assert!(!s.matches(&Pep440Version::parse("2.0").unwrap()));
    }
}
