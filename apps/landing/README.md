# Better Landing (Next.js)

Terminal-inspired marketing site for **Better: Dependency Toolkit for Node.js**.

## Fonts

This app uses Geist fonts from npm:

- `GeistSans`
- `GeistMono`
- `GeistPixelSquare`
- `GeistPixelLine`

## Development

```bash
cd apps/landing
npm install
npm run dev
```

## Build / Lint with Better

If you want to use Better in the dependency setup step before build/lint:

```bash
cd apps/landing
npm run build:better
npm run lint:better
```

These scripts run:

```bash
node ../../bin/better.js install --project-root . --pm npm --engine pm --json
```

then execute the normal Next.js build/lint command.

## Deploy to Vercel

1. Import this repository in Vercel.
2. Set **Root Directory** to `apps/landing`.
3. Build command: `npm run build`
4. Output: Next.js default (`.next`)
