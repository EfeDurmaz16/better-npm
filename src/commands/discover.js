/**
 * better discover — discover OSP service providers
 *
 * JS-native: curated provider database with category/keyword filtering.
 * Delegates to better-core binary if available for live registry queries.
 */

import { parseArgs } from "node:util";
import { printJson, printText } from "../lib/output.js";
import { getRuntimeConfig } from "../lib/config.js";
import { findBetterCore } from "../lib/core.js";
import { runCommand } from "../lib/spawn.js";

const HELP = `better discover — find OSP service providers

Usage:
  better discover <query>                  Search by keyword or category
  better discover <domain>                 Inspect a specific provider
  better discover --category <type>        Filter by service category

Arguments:
  query   Keyword (e.g. "database", "redis", "auth") or provider domain

Options:
  --category TYPE  Filter by: database|hosting|auth|analytics|storage|compute|messaging|search|ai|email
  --free           Show only free-tier offerings
  --json           Machine-readable output (returns JSON array)
  -h, --help       Show this help

Examples:
  better discover database
  better discover supabase.com
  better discover --category auth
  better discover redis --free
`;

/** Curated OSP provider registry — JS-native fallback */
const PROVIDERS = [
  {
    provider_id: "supabase.com",
    name: "Supabase",
    description: "Open source Firebase alternative with Postgres, Auth, Storage, and Functions",
    homepage: "https://supabase.com",
    category: "database",
    tags: ["postgres", "database", "realtime", "auth", "storage", "functions", "open-source"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "postgres", name: "Postgres Database", description: "Fully managed Postgres", free: true },
      { id: "auth", name: "Auth", description: "User authentication with OAuth, magic link, and more", free: true },
      { id: "storage", name: "Storage", description: "S3-compatible object storage", free: true },
    ]
  },
  {
    provider_id: "upstash.com",
    name: "Upstash",
    description: "Serverless Redis, Kafka, and Vector database",
    homepage: "https://upstash.com",
    category: "database",
    tags: ["redis", "kafka", "vector", "serverless", "database"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "redis", name: "Redis", description: "Serverless Redis with REST API", free: true },
      { id: "kafka", name: "Kafka", description: "Serverless Kafka", free: true },
      { id: "vector", name: "Vector", description: "Serverless vector database for AI embeddings", free: true },
    ]
  },
  {
    provider_id: "neon.tech",
    name: "Neon",
    description: "Serverless Postgres with branching and autoscaling",
    homepage: "https://neon.tech",
    category: "database",
    tags: ["postgres", "database", "serverless", "branching"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "postgres", name: "Postgres", description: "Serverless Postgres with branching", free: true },
    ]
  },
  {
    provider_id: "planetscale.com",
    name: "PlanetScale",
    description: "MySQL-compatible serverless database with branching workflow",
    homepage: "https://planetscale.com",
    category: "database",
    tags: ["mysql", "database", "serverless", "branching"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "mysql", name: "MySQL", description: "MySQL-compatible serverless database", free: true },
    ]
  },
  {
    provider_id: "mongodb.com",
    name: "MongoDB Atlas",
    description: "Fully managed MongoDB in the cloud",
    homepage: "https://mongodb.com/atlas",
    category: "database",
    tags: ["mongodb", "nosql", "database", "document"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "mongodb", name: "MongoDB", description: "Fully managed MongoDB clusters", free: true },
    ]
  },
  {
    provider_id: "railway.app",
    name: "Railway",
    description: "Deploy apps and databases with one click",
    homepage: "https://railway.app",
    category: "hosting",
    tags: ["hosting", "deploy", "postgres", "mysql", "redis", "mongodb"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "hosting", name: "App Hosting", description: "Container-based app deployment", free: true },
      { id: "postgres", name: "Postgres", description: "Managed Postgres", free: true },
      { id: "redis", name: "Redis", description: "Managed Redis", free: true },
      { id: "mysql", name: "MySQL", description: "Managed MySQL", free: true },
    ]
  },
  {
    provider_id: "vercel.com",
    name: "Vercel",
    description: "Frontend hosting and serverless functions for Next.js and more",
    homepage: "https://vercel.com",
    category: "hosting",
    tags: ["hosting", "serverless", "next.js", "edge", "functions", "deploy"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "hosting", name: "Frontend Hosting", description: "Optimized hosting for Next.js, React, Vue", free: true },
      { id: "functions", name: "Serverless Functions", description: "Edge and serverless functions", free: true },
      { id: "storage", name: "Blob Storage", description: "File and blob storage", free: true },
      { id: "postgres", name: "Postgres", description: "Serverless Postgres powered by Neon", free: true },
    ]
  },
  {
    provider_id: "netlify.com",
    name: "Netlify",
    description: "Web hosting and automation platform for static sites and serverless functions",
    homepage: "https://netlify.com",
    category: "hosting",
    tags: ["hosting", "serverless", "static", "edge", "functions", "deploy"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "hosting", name: "Static Hosting", description: "CDN hosting for static sites", free: true },
      { id: "functions", name: "Serverless Functions", description: "On-demand serverless functions", free: true },
      { id: "edge", name: "Edge Functions", description: "Low-latency edge compute", free: true },
    ]
  },
  {
    provider_id: "cloudflare.com",
    name: "Cloudflare",
    description: "Global CDN, Workers, R2 storage, D1 database, and KV",
    homepage: "https://cloudflare.com",
    category: "hosting",
    tags: ["hosting", "cdn", "workers", "edge", "storage", "database", "kv"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "workers", name: "Workers", description: "Serverless JavaScript at the edge", free: true },
      { id: "r2", name: "R2 Storage", description: "S3-compatible object storage", free: true },
      { id: "d1", name: "D1 Database", description: "Serverless SQLite database at the edge", free: true },
      { id: "kv", name: "KV", description: "Global key-value store", free: true },
    ]
  },
  {
    provider_id: "fly.io",
    name: "Fly.io",
    description: "Run Docker containers close to users with anycast networking",
    homepage: "https://fly.io",
    category: "hosting",
    tags: ["hosting", "docker", "containers", "deploy", "postgres"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "apps", name: "App Hosting", description: "Run containers globally", free: true },
      { id: "postgres", name: "Postgres", description: "Managed Postgres on Fly machines", free: true },
    ]
  },
  {
    provider_id: "auth0.com",
    name: "Auth0",
    description: "Identity and authentication platform with OAuth, OIDC, SAML support",
    homepage: "https://auth0.com",
    category: "auth",
    tags: ["auth", "identity", "oauth", "oidc", "saml", "sso", "mfa"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "auth", name: "Authentication", description: "Social, enterprise, and passwordless login", free: true },
      { id: "mfa", name: "MFA", description: "Multi-factor authentication", free: true },
    ]
  },
  {
    provider_id: "clerk.com",
    name: "Clerk",
    description: "Complete authentication and user management for React, Next.js, and more",
    homepage: "https://clerk.com",
    category: "auth",
    tags: ["auth", "identity", "oauth", "react", "next.js", "user-management"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "auth", name: "Authentication", description: "Pre-built auth UI components", free: true },
      { id: "user-management", name: "User Management", description: "User profiles and organization management", free: true },
    ]
  },
  {
    provider_id: "workos.com",
    name: "WorkOS",
    description: "Enterprise-ready auth: SSO, SCIM, audit log for B2B SaaS",
    homepage: "https://workos.com",
    category: "auth",
    tags: ["auth", "sso", "saml", "scim", "enterprise", "b2b"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "sso", name: "SSO", description: "Enterprise Single Sign-On", free: true },
      { id: "directory-sync", name: "Directory Sync", description: "SCIM provisioning", free: false },
    ]
  },
  {
    provider_id: "resend.com",
    name: "Resend",
    description: "Email API for developers built with React Email",
    homepage: "https://resend.com",
    category: "email",
    tags: ["email", "transactional", "smtp", "api", "react-email"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "email", name: "Email API", description: "Send transactional email via API or SMTP", free: true },
    ]
  },
  {
    provider_id: "sendgrid.com",
    name: "SendGrid",
    description: "Email delivery service for transactional and marketing email",
    homepage: "https://sendgrid.com",
    category: "email",
    tags: ["email", "transactional", "marketing", "smtp"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "email", name: "Email API", description: "Transactional and marketing email", free: true },
    ]
  },
  {
    provider_id: "postmark.com",
    name: "Postmark",
    description: "Fast and reliable transactional email delivery",
    homepage: "https://postmark.com",
    category: "email",
    tags: ["email", "transactional", "smtp", "deliverability"],
    free_tier: false,
    osp_compatible: true,
    offerings: [
      { id: "email", name: "Transactional Email", description: "High-deliverability transactional email", free: false },
    ]
  },
  {
    provider_id: "mixpanel.com",
    name: "Mixpanel",
    description: "Product analytics for tracking user behavior and events",
    homepage: "https://mixpanel.com",
    category: "analytics",
    tags: ["analytics", "events", "product", "tracking", "funnels"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "analytics", name: "Product Analytics", description: "Event-based analytics with funnels", free: true },
    ]
  },
  {
    provider_id: "posthog.com",
    name: "PostHog",
    description: "Open source product analytics, feature flags, session replay, and A/B testing",
    homepage: "https://posthog.com",
    category: "analytics",
    tags: ["analytics", "feature-flags", "session-replay", "ab-testing", "open-source"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "analytics", name: "Analytics", description: "Full product analytics suite", free: true },
      { id: "feature-flags", name: "Feature Flags", description: "Rollout and A/B test control", free: true },
      { id: "session-replay", name: "Session Replay", description: "Record and replay user sessions", free: true },
    ]
  },
  {
    provider_id: "aws.amazon.com/s3",
    name: "AWS S3",
    description: "Industry-standard scalable object storage",
    homepage: "https://aws.amazon.com/s3",
    category: "storage",
    tags: ["storage", "s3", "object-storage", "aws"],
    free_tier: true,
    osp_compatible: false,
    offerings: [
      { id: "s3", name: "S3", description: "Scalable object storage", free: true },
    ]
  },
  {
    provider_id: "cloudinary.com",
    name: "Cloudinary",
    description: "Media management and CDN for images and videos",
    homepage: "https://cloudinary.com",
    category: "storage",
    tags: ["storage", "images", "video", "cdn", "media", "transforms"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "media", name: "Media Management", description: "Image and video storage with transforms", free: true },
    ]
  },
  {
    provider_id: "algolia.com",
    name: "Algolia",
    description: "Hosted search API with typo tolerance and faceted filtering",
    homepage: "https://algolia.com",
    category: "search",
    tags: ["search", "full-text", "instant", "facets", "api"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "search", name: "Search", description: "Instant full-text search API", free: true },
      { id: "recommend", name: "Recommend", description: "AI-powered recommendations", free: false },
    ]
  },
  {
    provider_id: "typesense.org",
    name: "Typesense",
    description: "Open source, typo-tolerant instant search engine",
    homepage: "https://typesense.org",
    category: "search",
    tags: ["search", "open-source", "instant", "typo-tolerant"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "search", name: "Search", description: "Hosted Typesense search", free: true },
    ]
  },
  {
    provider_id: "openai.com",
    name: "OpenAI",
    description: "GPT-4, embeddings, image generation, and assistants API",
    homepage: "https://openai.com",
    category: "ai",
    tags: ["ai", "llm", "gpt", "embeddings", "images", "assistants"],
    free_tier: false,
    osp_compatible: true,
    offerings: [
      { id: "chat", name: "Chat Completions", description: "GPT-4 and GPT-3.5 API", free: false },
      { id: "embeddings", name: "Embeddings", description: "Text embedding API", free: false },
      { id: "images", name: "Image Generation", description: "DALL-E image generation", free: false },
    ]
  },
  {
    provider_id: "anthropic.com",
    name: "Anthropic",
    description: "Claude AI models for text generation, analysis, and coding",
    homepage: "https://anthropic.com",
    category: "ai",
    tags: ["ai", "llm", "claude", "text", "analysis", "coding"],
    free_tier: false,
    osp_compatible: true,
    offerings: [
      { id: "claude", name: "Claude API", description: "Claude 3 Opus, Sonnet, and Haiku", free: false },
    ]
  },
  {
    provider_id: "pinecone.io",
    name: "Pinecone",
    description: "Managed vector database for AI applications and semantic search",
    homepage: "https://pinecone.io",
    category: "ai",
    tags: ["ai", "vector-database", "embeddings", "semantic-search"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "vector-db", name: "Vector Database", description: "High-performance vector storage and search", free: true },
    ]
  },
  {
    provider_id: "twilio.com",
    name: "Twilio",
    description: "Communications APIs for SMS, voice, email, and more",
    homepage: "https://twilio.com",
    category: "messaging",
    tags: ["messaging", "sms", "voice", "whatsapp", "email"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "sms", name: "SMS", description: "Send and receive SMS globally", free: false },
      { id: "voice", name: "Voice", description: "Programmable voice calls", free: false },
      { id: "email", name: "SendGrid Email", description: "Email delivery (via SendGrid)", free: true },
    ]
  },
  {
    provider_id: "pusher.com",
    name: "Pusher",
    description: "Hosted WebSockets and pub/sub messaging for real-time features",
    homepage: "https://pusher.com",
    category: "messaging",
    tags: ["messaging", "websockets", "realtime", "pubsub", "channels"],
    free_tier: true,
    osp_compatible: true,
    offerings: [
      { id: "channels", name: "Channels", description: "WebSocket pub/sub at scale", free: true },
      { id: "beams", name: "Beams", description: "Push notifications for mobile and web", free: true },
    ]
  },
  {
    provider_id: "stripe.com",
    name: "Stripe",
    description: "Payments infrastructure for the internet",
    homepage: "https://stripe.com",
    category: "payments",
    tags: ["payments", "billing", "subscriptions", "checkout"],
    free_tier: false,
    osp_compatible: true,
    offerings: [
      { id: "payments", name: "Payments", description: "Accept online payments", free: false },
      { id: "billing", name: "Billing", description: "Subscription billing", free: false },
    ]
  },
];

/** Return providers matching the given query/category/free filters */
function filterProviders(query, category, freeOnly) {
  let results = PROVIDERS;

  if (category) {
    const cat = category.toLowerCase();
    results = results.filter(p => p.category === cat);
  }

  if (freeOnly) {
    results = results.filter(p => p.free_tier === true);
  }

  if (query) {
    const q = query.toLowerCase();
    // Domain match (exact or partial)
    const domainMatch = results.filter(p =>
      p.provider_id.includes(q) || p.name.toLowerCase().includes(q)
    );
    if (domainMatch.length > 0) return domainMatch;
    // Keyword match: description, tags
    results = results.filter(p =>
      p.description.toLowerCase().includes(q) ||
      p.tags.some(t => t.includes(q)) ||
      p.category.includes(q)
    );
  }

  return results;
}

export async function cmdDiscover(argv) {
  const runtime = getRuntimeConfig();
  if (!argv[0] || argv.includes("-h") || argv.includes("--help")) {
    printText(HELP);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      category: { type: "string" },
      free:     { type: "boolean", default: false },
      json:     { type: "boolean", default: runtime.json === true },
    },
    allowPositionals: true,
    strict: false,
  });

  const query = positionals[0];

  // Try better-core binary for live registry queries
  const corePath = await findBetterCore();
  if (corePath) {
    const coreArgs = ["discover"];
    if (query) coreArgs.push(query);
    if (values.category) coreArgs.push("--category", values.category);
    if (values.free)     coreArgs.push("--free");
    if (values.json)     coreArgs.push("--json");
    const res = await runCommand(corePath, coreArgs, { passthroughStdio: !values.json });
    process.exitCode = res.exitCode ?? 0;
    if (values.json && res.stdout) {
      try { printJson(JSON.parse(res.stdout.trim())); } catch { printText(res.stdout.trim()); }
    }
    return;
  }

  // JS-native fallback: curated provider database
  const matches = filterProviders(query, values.category, values.free);

  if (values.json) {
    // Return array of matching providers
    process.stdout.write(JSON.stringify(matches, null, 2) + "\n");
    return;
  }

  // Human-readable output
  if (matches.length === 0) {
    printText(`No providers found${query ? ` for "${query}"` : ""}.`);
    return;
  }

  const lines = [
    `Found ${matches.length} provider${matches.length === 1 ? "" : "s"}${query ? ` for "${query}"` : ""}:`,
    ""
  ];
  for (const p of matches) {
    const freeBadge = p.free_tier ? " [free tier]" : "";
    const ospBadge  = p.osp_compatible ? " [OSP]" : "";
    lines.push(`  ${p.name}${freeBadge}${ospBadge}`);
    lines.push(`    ${p.provider_id}`);
    lines.push(`    ${p.description}`);
    lines.push(`    categories: ${p.category} | tags: ${p.tags.slice(0, 5).join(", ")}`);
    lines.push("");
  }
  printText(lines.join("\n"));
}
