use std::cmp::Ordering;
use std::fmt;

/// PEP 440 version: [N!]N[.N]+[{a|b|rc}N][.postN][.devN][+local]
#[derive(Debug, Clone, Eq)]
pub struct Pep440Version {
    pub epoch: u32,
    pub release: Vec<u32>,
    pub pre: Option<PreRelease>,
    pub post: Option<u32>,
    pub dev: Option<u32>,
    pub local: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreRelease {
    Alpha(u32),
    Beta(u32),
    Rc(u32),
}

impl PreRelease {
    fn order_key(&self) -> (u8, u32) {
        match self {
            PreRelease::Alpha(n) => (0, *n),
            PreRelease::Beta(n) => (1, *n),
            PreRelease::Rc(n) => (2, *n),
        }
    }
}

impl PartialEq for Pep440Version {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Pep440Version {
    /// Convert to a sort key tuple for PEP 440 ordering.
    /// Returns (epoch, release..., pre_key, post_key, dev_key).
    ///
    /// PEP 440 ordering:
    ///   1.0.dev0 < 1.0a1.dev0 < 1.0a1 < 1.0b1 < 1.0rc1 < 1.0 < 1.0.post1
    fn sort_key(&self) -> (u32, Vec<u32>, (i64, i64), (i64, i64), (i64, i64)) {
        // Pre-release key: dev-only gets (-1, 0), pre gets (0, type*100+n), none gets (1, 0)
        let pre_key: (i64, i64) = match &self.pre {
            Some(PreRelease::Alpha(n)) => (0, *n as i64),
            Some(PreRelease::Beta(n)) => (1, *n as i64),
            Some(PreRelease::Rc(n)) => (2, *n as i64),
            None => {
                if self.dev.is_some() && self.post.is_none() {
                    // dev-only (no pre, no post): comes before any pre-release
                    (-1, 0)
                } else {
                    // final or post release
                    (3, 0)
                }
            }
        };

        // Post key: None -> (0, 0), Some(n) -> (1, n)
        let post_key: (i64, i64) = match self.post {
            None => (0, 0),
            Some(n) => (1, n as i64),
        };

        // Dev key: None -> (1, 0) (higher = no dev suffix), Some(n) -> (0, n)
        let dev_key: (i64, i64) = match self.dev {
            None => (1, 0),
            Some(n) => (0, n as i64),
        };

        // Pad release to consistent length for comparison
        let mut release = self.release.clone();
        while release.len() < 10 {
            release.push(0);
        }

        (self.epoch, release, pre_key, post_key, dev_key)
    }
}

impl Ord for Pep440Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.sort_key().cmp(&other.sort_key())
    }
}

impl PartialOrd for Pep440Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Pep440Version {
    /// Parse a PEP 440 version string.
    ///
    /// Format: [N!]N[.N]+[{a|b|c|rc|alpha|beta|preview}N][.postN][.devN][+local]
    pub fn parse(input: &str) -> Result<Self, String> {
        let input = input.trim();
        if input.is_empty() {
            return Err("empty version string".to_string());
        }

        // Strip leading 'v' or 'V' (common non-standard prefix)
        let input = input.strip_prefix('v').or_else(|| input.strip_prefix('V')).unwrap_or(input);

        // Split off +local
        let (main, local) = match input.find('+') {
            Some(pos) => (&input[..pos], Some(input[pos + 1..].to_string())),
            None => (input, None),
        };

        // Split off epoch
        let (epoch, rest) = match main.find('!') {
            Some(pos) => {
                let e = main[..pos]
                    .parse::<u32>()
                    .map_err(|_| format!("invalid epoch in '{}'", input))?;
                (e, &main[pos + 1..])
            }
            None => (0, main),
        };

        // Parse release segments and pre/post/dev suffixes
        let mut release = Vec::new();
        let mut pre = None;
        let mut post = None;
        let mut dev = None;

        // Tokenize: split by '.' but handle suffixes like a1, b2, rc3, post1, dev1
        let mut remaining = rest;

        // Parse release segments
        loop {
            // Try to parse a numeric segment
            let num_end = remaining
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(remaining.len());
            if num_end == 0 {
                // No more numeric segments; check for pre/post/dev
                break;
            }
            let num_str = &remaining[..num_end];
            let num = num_str
                .parse::<u32>()
                .map_err(|_| format!("invalid version segment '{}' in '{}'", num_str, input))?;
            release.push(num);
            remaining = &remaining[num_end..];

            // Check what follows
            if remaining.is_empty() {
                break;
            }

            if remaining.starts_with('.') {
                remaining = &remaining[1..];
                // Check if next part is a known suffix
                let lower = remaining.to_lowercase();
                if lower.starts_with("post")
                    || lower.starts_with("dev")
                    || lower.starts_with("alpha")
                    || lower.starts_with("beta")
                    || lower.starts_with("preview")
                    || lower.starts_with("rc")
                    || lower.starts_with('a')
                    || lower.starts_with('b')
                    || lower.starts_with('c')
                {
                    // Could be a suffix or could be a segment — check if it starts with digit
                    if remaining.chars().next().map_or(false, |c| c.is_ascii_digit()) {
                        // It's another release segment
                        continue;
                    }
                    // It's a suffix, handle below
                    break;
                }
                // Next segment
                continue;
            }

            // Non-dot separator: must be start of pre/post/dev suffix
            break;
        }

        if release.is_empty() {
            return Err(format!("no release segments in '{}'", input));
        }

        // Parse suffixes from remaining
        let remaining_lower = remaining.to_lowercase();
        let mut suffix = remaining_lower.as_str();

        // Handle separators: -, _, .
        suffix = suffix.trim_start_matches(|c: char| c == '-' || c == '_' || c == '.');

        // Parse pre-release
        if let Some(rest) = suffix.strip_prefix("alpha") {
            let (n, r) = parse_suffix_number(rest);
            pre = Some(PreRelease::Alpha(n));
            suffix = r;
        } else if let Some(rest) = suffix.strip_prefix("beta") {
            let (n, r) = parse_suffix_number(rest);
            pre = Some(PreRelease::Beta(n));
            suffix = r;
        } else if let Some(rest) = suffix.strip_prefix("preview") {
            let (n, r) = parse_suffix_number(rest);
            pre = Some(PreRelease::Rc(n));
            suffix = r;
        } else if let Some(rest) = suffix.strip_prefix("rc") {
            let (n, r) = parse_suffix_number(rest);
            pre = Some(PreRelease::Rc(n));
            suffix = r;
        } else if suffix.starts_with('c') && !suffix.starts_with("cu") {
            let rest = &suffix[1..];
            let (n, r) = parse_suffix_number(rest);
            pre = Some(PreRelease::Rc(n));
            suffix = r;
        } else if suffix.starts_with('b') {
            let rest = &suffix[1..];
            let (n, r) = parse_suffix_number(rest);
            pre = Some(PreRelease::Beta(n));
            suffix = r;
        } else if suffix.starts_with('a') {
            let rest = &suffix[1..];
            let (n, r) = parse_suffix_number(rest);
            pre = Some(PreRelease::Alpha(n));
            suffix = r;
        }

        // Skip separators
        suffix = suffix.trim_start_matches(|c: char| c == '-' || c == '_' || c == '.');

        // Parse post-release
        if let Some(rest) = suffix.strip_prefix("post") {
            let (n, r) = parse_suffix_number(rest);
            post = Some(n);
            suffix = r;
        } else if let Some(rest) = suffix.strip_prefix("rev") {
            let (n, r) = parse_suffix_number(rest);
            post = Some(n);
            suffix = r;
        } else if let Some(rest) = suffix.strip_prefix('r') {
            if rest.chars().next().map_or(false, |c| c.is_ascii_digit()) {
                let (n, r) = parse_suffix_number(rest);
                post = Some(n);
                suffix = r;
            }
        }

        // Skip separators
        suffix = suffix.trim_start_matches(|c: char| c == '-' || c == '_' || c == '.');

        // Parse dev
        if let Some(rest) = suffix.strip_prefix("dev") {
            let (n, _r) = parse_suffix_number(rest);
            dev = Some(n);
        }

        Ok(Pep440Version {
            epoch,
            release,
            pre,
            post,
            dev,
            local,
        })
    }

    /// Whether this version is a pre-release (includes dev releases).
    pub fn is_prerelease(&self) -> bool {
        self.pre.is_some() || self.dev.is_some()
    }

    /// Normalized string representation per PEP 440.
    pub fn normalize(&self) -> String {
        let mut s = String::new();
        if self.epoch != 0 {
            s.push_str(&format!("{}!", self.epoch));
        }
        let rel: Vec<String> = self.release.iter().map(|n| n.to_string()).collect();
        s.push_str(&rel.join("."));
        if let Some(ref pre) = self.pre {
            match pre {
                PreRelease::Alpha(n) => s.push_str(&format!("a{}", n)),
                PreRelease::Beta(n) => s.push_str(&format!("b{}", n)),
                PreRelease::Rc(n) => s.push_str(&format!("rc{}", n)),
            }
        }
        if let Some(n) = self.post {
            s.push_str(&format!(".post{}", n));
        }
        if let Some(n) = self.dev {
            s.push_str(&format!(".dev{}", n));
        }
        if let Some(ref local) = self.local {
            s.push('+');
            s.push_str(local);
        }
        s
    }
}

impl fmt::Display for Pep440Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.normalize())
    }
}

/// Parse a number immediately after a suffix keyword. Returns (number, rest).
fn parse_suffix_number(s: &str) -> (u32, &str) {
    // Skip optional separator
    let s = s.trim_start_matches(|c: char| c == '-' || c == '_' || c == '.');
    let num_end = s
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(s.len());
    if num_end == 0 {
        return (0, s);
    }
    let n = s[..num_end].parse::<u32>().unwrap_or(0);
    (n, &s[num_end..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pep440_simple() {
        let v = Pep440Version::parse("1.2.3").unwrap();
        assert_eq!(v.release, vec![1, 2, 3]);
        assert_eq!(v.epoch, 0);
        assert!(v.pre.is_none());
        assert!(v.post.is_none());
        assert!(v.dev.is_none());
        assert!(v.local.is_none());
    }

    #[test]
    fn test_pep440_full() {
        let v = Pep440Version::parse("2!1.0a1.post2.dev3").unwrap();
        assert_eq!(v.epoch, 2);
        assert_eq!(v.release, vec![1, 0]);
        assert_eq!(v.pre, Some(PreRelease::Alpha(1)));
        assert_eq!(v.post, Some(2));
        assert_eq!(v.dev, Some(3));
    }

    #[test]
    fn test_pep440_prerelease() {
        let v = Pep440Version::parse("1.0a1").unwrap();
        assert_eq!(v.pre, Some(PreRelease::Alpha(1)));
        assert!(v.is_prerelease());

        let v = Pep440Version::parse("1.0b2").unwrap();
        assert_eq!(v.pre, Some(PreRelease::Beta(2)));

        let v = Pep440Version::parse("1.0rc1").unwrap();
        assert_eq!(v.pre, Some(PreRelease::Rc(1)));
    }

    #[test]
    fn test_pep440_post() {
        let v = Pep440Version::parse("1.0.post1").unwrap();
        assert_eq!(v.post, Some(1));
        assert!(!v.is_prerelease());
    }

    #[test]
    fn test_pep440_dev() {
        let v = Pep440Version::parse("1.0.dev5").unwrap();
        assert_eq!(v.dev, Some(5));
        assert!(v.is_prerelease());
    }

    #[test]
    fn test_pep440_local() {
        let v = Pep440Version::parse("1.0+local.1").unwrap();
        assert_eq!(v.local, Some("local.1".to_string()));
    }

    #[test]
    fn test_pep440_epoch() {
        let v = Pep440Version::parse("2!1.0").unwrap();
        assert_eq!(v.epoch, 2);
        assert_eq!(v.release, vec![1, 0]);
    }

    #[test]
    fn test_pep440_ordering() {
        let a = Pep440Version::parse("1.0a1").unwrap();
        let b = Pep440Version::parse("1.0b1").unwrap();
        let c = Pep440Version::parse("1.0rc1").unwrap();
        let d = Pep440Version::parse("1.0").unwrap();
        let e = Pep440Version::parse("1.0.post1").unwrap();
        assert!(a < b, "alpha < beta");
        assert!(b < c, "beta < rc");
        assert!(c < d, "rc < final");
        assert!(d < e, "final < post");
    }

    #[test]
    fn test_pep440_dev_ordering() {
        let dev = Pep440Version::parse("1.0.dev1").unwrap();
        let alpha = Pep440Version::parse("1.0a1").unwrap();
        let final_v = Pep440Version::parse("1.0").unwrap();
        assert!(dev < alpha, "dev < alpha");
        assert!(alpha < final_v, "alpha < final");
    }

    #[test]
    fn test_pep440_epoch_ordering() {
        let a = Pep440Version::parse("1!1.0").unwrap();
        let b = Pep440Version::parse("2.0").unwrap();
        assert!(a > b, "epoch 1 > epoch 0 regardless of release");
    }

    #[test]
    fn test_pep440_normalize() {
        let v = Pep440Version::parse("1.0.0").unwrap();
        assert_eq!(v.normalize(), "1.0.0");

        let v = Pep440Version::parse("2!1.0a1.post2.dev3+local").unwrap();
        assert_eq!(v.normalize(), "2!1.0a1.post2.dev3+local");
    }

    #[test]
    fn test_pep440_v_prefix() {
        let v = Pep440Version::parse("v1.2.3").unwrap();
        assert_eq!(v.release, vec![1, 2, 3]);
    }

    #[test]
    fn test_pep440_padding() {
        let a = Pep440Version::parse("1.0").unwrap();
        let b = Pep440Version::parse("1.0.0").unwrap();
        assert_eq!(a, b, "1.0 == 1.0.0 (zero-padded)");
    }
}
