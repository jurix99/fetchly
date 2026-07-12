---
name: fetchly-frontend-architecture
description: How the Fetchly frontend is structured (SPA view-state, not Next routes) and key backend search facts
metadata:
  type: project
---

Fetchly frontend is a **Next.js static export** (`output: "export"`, served by FastAPI). It is a **single-page app driven by `AppShell` view state** ([frontend/components/app-shell.tsx](frontend/components/app-shell.tsx)) — `view` is one of `home|library|explorer|subscriptions|downloads|settings`, plus a `content` detail overlay. There are **no per-path Next routes per view**; deep-linking is done via URL query params parsed once in an app-shell `useEffect` (`?content=<id>&t=<seconds>`). So "add a `/search` route" means **add a new view + URL query sync**, not a Next route.

- Design rules live in [frontend/DESIGN.md](frontend/DESIGN.md): reuse `InlineFeedback` (loading/empty/error), `Empty`, `status-badge`; no new UI deps, no new colors outside tokens (`primary/muted/success/warning/info/destructive`).
- shadcn **`command` component is NOT installed** — build palettes from `dialog` + custom list.
- Typed API client: [frontend/lib/backend.ts](frontend/lib/backend.ts) (`backend.*`). Store/state: [frontend/components/store-provider.tsx](frontend/components/store-provider.tsx) (no extra state manager allowed).
- Hybrid search: GET `/api/search?q=&scope=&limit=` → `indexer.search()` ([app/indexer.py](app/indexer.py)); RRF over FTS5 (segments+contents) + sqlite-vec KNN. FTS snippets embed highlight markers `char(2)`/`char(3)` (STX/ETX); semantic passages carry `match_type:"semantic"` with no markers. DB is stdlib sqlite3 in [app/db.py](app/db.py) (`contents`, `transcript_segments`, `transcript_chunks`, `vec_chunks`, FTS mirrors). Note: `/api/search` GET = library hybrid search; POST `/api/search` = YouTube discovery (different route module).
