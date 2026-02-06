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

## Build / Lint / Dev with Better

This app can be controlled directly through Better script aliases:

```bash
cd apps/landing
node ../../bin/better.js install --project-root . --pm npm
npm run dev:better
npm run lint:better
npm run build:better
npm run test:better
```

## Deploy to Vercel

1. Import this repository in Vercel.
2. Set **Root Directory** to `apps/landing`.
3. Build command: `npm run build`
4. Output: Next.js default (`.next`)
