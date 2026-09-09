use std::process::Command;

#[test]
fn install_rejects_unsupported_guarantees_before_resolving() {
    // Cargo supplies the binary built from the current source, never a stale local build.
    for subcommand in ["install", "i"] {
        for (flag, reason) in [
            ("--sandbox", "script isolation"),
            ("--verify-provenance", "cryptographic provenance"),
            ("--require-provenance", "cryptographic provenance"),
        ] {
            let output = Command::new(env!("CARGO_BIN_EXE_better-core"))
                .args([subcommand, flag, "--lockfile", "missing-contract-lock.json"])
                .output()
                .expect("run better-core");
            assert!(!output.status.success(), "{subcommand} {flag} must fail");
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(text.contains(flag) && text.contains(reason), "{text}");
        }
    }
}
