import { GeistMono } from "geist/font/mono";
import { GeistPixelLine, GeistPixelSquare } from "geist/font/pixel";

const navItems = [
  { href: "#vision", label: "Vision" },
  { href: "#how", label: "How It Works" },
  { href: "#benchmark", label: "Benchmarks" },
  { href: "#reports", label: "Reports" },
  { href: "#teams", label: "For Teams" },
  { href: "#docs", label: "Docs" }
];

const benchmarkCards = [
  {
    title: "Aspendos: raw bun vs better+bun",
    highlight: "84.1% faster",
    statA: "raw bun: 96.02s",
    statB: "better+bun: 15.25s"
  },
  {
    title: "Sardis: npm cold vs better cache-hit",
    highlight: "59.1% faster",
    statA: "npm cold: 16.65s",
    statB: "better warm-hit (rust): 6.81s"
  },
  {
    title: "Sardis: JS vs Rust materialize",
    highlight: "22.0% lower wall time",
    statA: "warm-hit js: 8.31s",
    statB: "warm-hit rust: 6.81s"
  }
];

const principles = [
  "Non-invasive: Wrap npm, pnpm, Yarn; do not replace them.",
  "Measurable: Every run emits time, size, hit/miss signals.",
  "Explainable: Every score and warning has a concrete reason.",
  "Observable: NDJSON logs + JSON reports for CI and platform teams."
];

const notes = [
  "[REPORT] Better 2.0: Rust Core Rewrite and Sub-10s Analysis",
  "[LOG] Global Cache Hit Path: 23,509 hardlinks in one run",
  "[POST] How Better computes Dependency Health Score",
  "[SPEC] Materialize Runtime Contract: JS fallback and Rust fast path"
];

export default function Page() {
  return (
    <div className="landing">
      <div className="scanlines" aria-hidden="true" />
      <header className="topbar">
        <div className="shell">
          <a href="#top" className={`brand ${GeistMono.className}`}>
            better_<span className="cursor">█</span>
          </a>
          <nav className={`menu ${GeistMono.className}`} aria-label="main">
            {navItems.map((item, idx) => (
              <span key={item.href}>
                <a href={item.href}>{item.label}</a>
                {idx !== navItems.length - 1 ? <span className="sep">|</span> : null}
              </span>
            ))}
            <a href="#cta" className="terminal-cta">
              curl better.sh | bash
            </a>
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="section hero">
          <div className="shell hero-grid">
            <div>
              <p className={`kicker ${GeistMono.className}`}>00_ DEPENDENCY OBSERVABILITY LAYER</p>
              <h1 className={GeistPixelSquare.className}>Stop Guessing Your Dependencies.</h1>
              <p className={`lead ${GeistMono.className}`}>
                Better wraps npm, pnpm, and Yarn with measurable install telemetry, shared cache behavior, deep
                analysis, and a health score. You get explainable data for time, storage, and dependency risk.
              </p>
              <div id="cta" className="hero-actions">
                <a href="#docs" className={`btn ${GeistMono.className}`}>
                  Join the Private Beta
                </a>
                <a href="#benchmark" className={`inline-link ${GeistMono.className}`}>
                  Read the Benchmark Report -&gt;
                </a>
              </div>
            </div>

            <aside className={`terminal ${GeistMono.className}`} aria-label="terminal">
              <div className="terminal-top">
                <span className="dots">● ● ●</span>
                <span>better@terminal</span>
              </div>
              <div className="terminal-body">
                <p className="line">
                  <span className="prompt">&gt;</span> better install
                  <span className="cursor">█</span>
                </p>
                <p className="line">[OK] 84.1% faster than raw bun on aspendos</p>
                <p className="line">[OK] 23,509 files linked from cache hit</p>
                <p className="line">
                  [OK] Health Score: <span className="accent">82/100</span>
                </p>
              </div>
            </aside>
          </div>
        </section>

        <section id="vision" className="section">
          <div className="shell">
            <h2 className={`section-title ${GeistPixelLine.className}`}>01_ VISION</h2>
            <div className="split">
              <div className={GeistMono.className}>
                <p>Better turns node_modules from a black box into an observable system.</p>
                <p>Every install, package, megabyte, and risk signal becomes queryable.</p>
                <p>
                  The product is aimed at long-lived codebases, monorepos, and platform teams that need reliable
                  dependency operations, not one-off speed tricks.
                </p>
              </div>
              <div className="principles">
                {principles.map((text) => (
                  <article key={text} className={`ghost ${GeistMono.className}`}>
                    {text}
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="how" className="section">
          <div className="shell">
            <h2 className={`section-title ${GeistPixelLine.className}`}>02_ WHAT BETTER DOES</h2>
            <div className="tracks">
              <article className="track">
                <div className={GeistMono.className}>
                  <h3>better install</h3>
                  <p>Wrap package managers and measure wall time, cache hit/miss, and storage impact.</p>
                </div>
                <pre className={GeistMono.className}>
                  {`> better install --json
{
  "durationMs": 15133,
  "execution": "pm_wrap",
  "cacheDecision": "disabled",
  "logicalBytes": 2373074944
}`}
                </pre>
              </article>

              <article className="track">
                <div className={GeistMono.className}>
                  <h3>better analyze</h3>
                  <p>Scan node_modules and extract duplicates, depth, deprecations, and top package contributors.</p>
                </div>
                <pre className={GeistMono.className}>
                  {`> better analyze --json
{
  "totalPackages": 2160,
  "directDependencies": 4,
  "maxDepth": 3,
  "duplicates": 195
}`}
                </pre>
              </article>

              <article className="track">
                <div className={GeistMono.className}>
                  <h3>better doctor</h3>
                  <p>Compute health score from deprecations, duplicates, depth, and policy thresholds.</p>
                </div>
                <pre className={GeistMono.className}>
                  {`> better doctor
Health Score: 73/100
ERROR: deprecated package found
WARN: duplicate version clusters
INFO: lockfile freshness drift`}
                </pre>
              </article>
            </div>
          </div>
        </section>

        <section id="benchmark" className="section">
          <div className="shell">
            <h2 className={`section-title ${GeistPixelLine.className}`}>03_ LIVE BENCHMARKS (2026-02-06)</h2>
            <div className="bench-grid">
              {benchmarkCards.map((card) => (
                <article key={card.title} className="bench-card">
                  <h3 className={GeistMono.className}>{card.title}</h3>
                  <p className={`bench-highlight ${GeistPixelSquare.className}`}>{card.highlight}</p>
                  <p className={GeistMono.className}>{card.statA}</p>
                  <p className={GeistMono.className}>{card.statB}</p>
                </article>
              ))}
            </div>
            <pre className={`method ${GeistMono.className}`}>
              {`# Method
/usr/bin/time -p npm install --ignore-scripts --no-audit --no-fund
/usr/bin/time -p bun install --frozen-lockfile
/usr/bin/time -p node bin/better.js install --engine better --global-cache --core-mode rust

# Report JSON
/tmp/compare-current-summary.json`}
            </pre>
          </div>
        </section>

        <section id="reports" className="section">
          <div className="shell">
            <h2 className={`section-title ${GeistPixelLine.className}`}>04_ REPORTS, NOT GUESSWORK</h2>
            <div className="report-grid">
              <pre className={GeistMono.className}>
                {`{
  "project": "aspendos-deploy",
  "rawBunSeconds": 96.02,
  "betterBunSeconds": 15.25,
  "deltaPercent": -84.1179,
  "execution": "pm_wrap"
}`}
              </pre>
              <div className="graph">
                <span className="node n1" />
                <span className="node n2" />
                <span className="node n3" />
                <span className="node n4" />
                <span className="node n5" />
                <span className="edge e1" />
                <span className="edge e2" />
                <span className="edge e3" />
                <span className={`tag t1 ${GeistMono.className}`}>lodash@4.17.21</span>
                <span className={`tag t2 ${GeistMono.className}`}>debug@4.3.1</span>
              </div>
            </div>
          </div>
        </section>

        <section id="teams" className="section">
          <div className="shell">
            <h2 className={`section-title ${GeistPixelLine.className}`}>05_ FOR TEAMS</h2>
            <div className="columns">
              <article className={GeistMono.className}>
                <h3>Infrastructure &amp; Platform</h3>
                <p>Track install performance across repos and enforce dependency budgets in CI.</p>
              </article>
              <article className={GeistMono.className}>
                <h3>Security &amp; Compliance</h3>
                <p>Connect deprecation and health findings to your existing security and governance workflow.</p>
              </article>
              <article className={GeistMono.className}>
                <h3>Engineering Leadership</h3>
                <p>Use real numbers for refactor prioritization, not anecdotes about slow installs.</p>
              </article>
            </div>
          </div>
        </section>

        <section id="docs" className="section">
          <div className="shell">
            <h2 className={`section-title ${GeistPixelLine.className}`}>06_ ENGINEERING NOTES</h2>
            <div className="notes">
              {notes.map((note) => (
                <a href="#" key={note} className={GeistMono.className}>
                  {note}
                </a>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="shell footer-grid">
          <div className={`brand ${GeistMono.className}`}>
            better_<span className="cursor">█</span>
          </div>
          <div className={`footer-links ${GeistMono.className}`}>
            <a href="#docs">Docs</a>
            <a href="https://github.com" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="#reports">Reports</a>
            <a href="#benchmark">Benchmarks</a>
          </div>
          <div className={GeistMono.className}>v0.1.0-alpha | Node.js + Rust core</div>
        </div>
      </footer>
    </div>
  );
}
