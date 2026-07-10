---
name: build-via-docker
description: How to build/typecheck the Fetchly frontend — npm isn't on PATH and WSL's Node is too old
metadata:
  type: project
---

Build the Fetchly frontend through Docker, not the host. `npm`/`node` are not on
the Windows PATH, and WSL's Node is v12.22 (too old for Next.js 16 / tsc 5.7).
The user asked to use WSL + docker compose.

**How to apply:**
- Frontend uses **pnpm** (`frontend/pnpm-lock.yaml`); production build is `pnpm build` (`next build`), run in the `node:22-slim` `frontend` stage of the root `Dockerfile`.
- Verify the build (== `npm run build`): from repo root, in WSL:
  `docker build --target frontend -t fetchly-frontend-check .`
- Next 16 build **skips TS type validation**. For a real typecheck, run inside the built image: `docker run --rm fetchly-frontend-check sh -lc 'cd /frontend && npx --no-install tsc --noEmit'`.
- Known **pre-existing** tsc errors (not build-blocking, unrelated to design-system work): `option-selects.tsx`, `store-provider.tsx:208` (sponsorBlockMode), `settings-view.tsx:114` (Slider), `mock-data.ts:294` (nfoExport).
