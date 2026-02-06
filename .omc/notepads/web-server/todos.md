# Web Server Implementation Todos

## Tasks

- [ ] Create `src/web/server.ts` with HTTP server using Node.js built-in http module
  - [ ] Static file serving from `src/web/public/`
  - [ ] CORS headers for local development
  - [ ] API endpoint: GET /api/analyze
  - [ ] API endpoint: GET /api/health
  - [ ] API endpoint: GET /api/cache/stats
  - [ ] Proper JSON Content-Type headers
  - [ ] Root path serves index.html

- [ ] Create `src/cli/commands/serve.ts` command
  - [ ] Register command with CLI
  - [ ] Support `--port` flag (default 3000)
  - [ ] Support `--no-open` flag
  - [ ] Open browser automatically by default
  - [ ] Start server and log URL

- [ ] Register serve command in `src/cli.ts`

- [ ] Run verification: `npm run typecheck && npm run build`
