use std::io::Write;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};

/// Real-time install progress bars using indicatif.
/// When `json_progress` is true, emits NDJSON events to stderr instead of TUI bars.
pub struct InstallProgress {
    _multi: MultiProgress,
    resolve_bar: ProgressBar,
    fetch_bar: ProgressBar,
    extract_bar: ProgressBar,
    link_bar: ProgressBar,
    json_progress: bool,
}

impl InstallProgress {
    pub fn new(is_tty: bool, json_progress: bool) -> Self {
        let multi = MultiProgress::new();

        let style = ProgressStyle::with_template(
            "{spinner:.green} {prefix:>12} [{bar:20.cyan/dim}] {pos}/{len} {msg}"
        )
        .unwrap()
        .progress_chars("##-");

        let resolve_bar = multi.add(ProgressBar::new(0));
        resolve_bar.set_style(style.clone());
        resolve_bar.set_prefix("Resolving");

        let fetch_bar = multi.add(ProgressBar::new(0));
        fetch_bar.set_style(style.clone());
        fetch_bar.set_prefix("Fetching");

        let extract_bar = multi.add(ProgressBar::new(0));
        extract_bar.set_style(style.clone());
        extract_bar.set_prefix("Extracting");

        let link_bar = multi.add(ProgressBar::new(0));
        link_bar.set_style(style);
        link_bar.set_prefix("Linking");

        if !is_tty || json_progress {
            resolve_bar.set_draw_target(indicatif::ProgressDrawTarget::hidden());
            fetch_bar.set_draw_target(indicatif::ProgressDrawTarget::hidden());
            extract_bar.set_draw_target(indicatif::ProgressDrawTarget::hidden());
            link_bar.set_draw_target(indicatif::ProgressDrawTarget::hidden());
        }

        Self {
            _multi: multi,
            resolve_bar,
            fetch_bar,
            extract_bar,
            link_bar,
            json_progress,
        }
    }

    // --- JSON progress helper ---
    fn emit_json(&self, phase: &str, current: u64, total: u64, bytes: u64) {
        if !self.json_progress {
            return;
        }
        let line = format!(
            "{{\"phase\":\"{}\",\"current\":{},\"total\":{},\"bytes\":{}}}\n",
            phase, current, total, bytes
        );
        let _ = std::io::stderr().write_all(line.as_bytes());
    }

    // --- Resolve ---
    pub fn set_resolve_total(&self, n: u64) {
        self.resolve_bar.set_length(n);
        self.emit_json("resolve", 0, n, 0);
    }

    pub fn inc_resolve(&self) {
        self.resolve_bar.inc(1);
        if self.json_progress {
            let pos = self.resolve_bar.position();
            let len = self.resolve_bar.length().unwrap_or(0);
            self.emit_json("resolve", pos, len, 0);
        }
    }

    pub fn finish_resolve(&self) {
        self.resolve_bar.finish_with_message("done");
        if self.json_progress {
            let len = self.resolve_bar.length().unwrap_or(0);
            self.emit_json("resolve", len, len, 0);
        }
    }

    // --- Fetch ---
    pub fn set_fetch_total(&self, n: u64) {
        self.fetch_bar.set_length(n);
        self.emit_json("fetch", 0, n, 0);
    }

    pub fn inc_fetch(&self) {
        self.fetch_bar.inc(1);
        if self.json_progress {
            let pos = self.fetch_bar.position();
            let len = self.fetch_bar.length().unwrap_or(0);
            self.emit_json("fetch", pos, len, 0);
        }
    }

    pub fn inc_fetch_bytes(&self, bytes: u64) {
        if self.json_progress {
            let pos = self.fetch_bar.position();
            let len = self.fetch_bar.length().unwrap_or(0);
            self.emit_json("fetch", pos, len, bytes);
        }
    }

    pub fn set_fetch_msg(&self, msg: &str) {
        self.fetch_bar.set_message(msg.to_string());
    }

    pub fn finish_fetch(&self) {
        self.fetch_bar.finish_with_message("done");
        if self.json_progress {
            let len = self.fetch_bar.length().unwrap_or(0);
            self.emit_json("fetch", len, len, 0);
        }
    }

    // --- Extract (materialize) ---
    pub fn set_extract_total(&self, n: u64) {
        self.extract_bar.set_length(n);
        self.emit_json("extract", 0, n, 0);
    }

    pub fn inc_extract(&self) {
        self.extract_bar.inc(1);
        if self.json_progress {
            let pos = self.extract_bar.position();
            let len = self.extract_bar.length().unwrap_or(0);
            self.emit_json("extract", pos, len, 0);
        }
    }

    pub fn finish_extract(&self) {
        self.extract_bar.finish_with_message("done");
        if self.json_progress {
            let len = self.extract_bar.length().unwrap_or(0);
            self.emit_json("extract", len, len, 0);
        }
    }

    // --- Link (bin links) ---
    pub fn set_link_total(&self, n: u64) {
        self.link_bar.set_length(n);
        self.emit_json("link", 0, n, 0);
    }

    pub fn inc_link(&self) {
        self.link_bar.inc(1);
        if self.json_progress {
            let pos = self.link_bar.position();
            let len = self.link_bar.length().unwrap_or(0);
            self.emit_json("link", pos, len, 0);
        }
    }

    pub fn finish_link(&self) {
        self.link_bar.finish_with_message("done");
        if self.json_progress {
            let len = self.link_bar.length().unwrap_or(0);
            self.emit_json("link", len, len, 0);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_non_tty_does_not_panic() {
        let _p = InstallProgress::new(false, false);
    }

    #[test]
    fn new_json_progress_does_not_panic() {
        let _p = InstallProgress::new(false, true);
    }

    #[test]
    fn set_totals_and_increment_no_panic() {
        let p = InstallProgress::new(false, false);
        p.set_resolve_total(10);
        p.inc_resolve();
        p.finish_resolve();
    }

    #[test]
    fn fetch_progress_methods_no_panic() {
        let p = InstallProgress::new(false, false);
        p.set_fetch_total(5);
        p.inc_fetch();
        p.inc_fetch_bytes(1024);
        p.set_fetch_msg("downloading");
        p.finish_fetch();
    }

    #[test]
    fn extract_and_link_no_panic() {
        let p = InstallProgress::new(false, false);
        p.set_extract_total(3);
        p.inc_extract();
        p.finish_extract();
        p.set_link_total(2);
        p.inc_link();
        p.finish_link();
    }
}
