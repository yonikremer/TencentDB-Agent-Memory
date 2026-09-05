# Team Memory Control

Team Memory Control is a stateless team memory management console for managing teams, users, Agents, tasks, and their associated assets such as Skills, Wiki, Code Graph, and Chat Memory.

## Project Positioning

Responsible for:

- Provide a Web management interface and a public Control API;
- Validate the caller's credentials and forward authorization requests;
- Aggregate metadata, memory assets, and knowledge assets;
- Manage asset allocation, binding, and display.

Control does not save the server-side login session nor maintain a local user database. Business data is persisted by external services configured at deployment time.

## Tech Stack

- Backend: Node.js 22+, TypeScript, Hono, tsx
- Frontend: React 18, Vite, TypeScript, Tailwind CSS, Zustand
- Testing: Vitest
- Package Management: pnpm (backend) and npm (frontend)

## Table of Contents

```text
src/
├── index.ts                  # Service entry
└── panel/
    ├── config/               # Configuration and Instance Registry
    ├── domain/               # Domain Rules
    ├── http/                 # Middleware and Public Routes
    ├── infra/                # Logging and Other Infrastructure
    ├── kernel/               # External Service Adapters
    └── startup/              # Startup Tasks

web/                          # React admin interface
config/                       # Example and description of instance registration
docker/                       # Container build files
docs/api/                     # External API contract
scripts/                      # Scripts for generation, testing, and security checks
tests/                        # Unit tests and E2E tests
```

## Local Development

### Prerequisites

- Node.js 22 or higher
- pnpm
- npm
- Accessible Memory Gateway
- When using Wiki or Code Graph, an accessible Knowledge Service is required

### 1. Install dependencies

```bash
pnpm install
cd web
npm install
cd ..
```

### 2. Prepare Configuration

```bash
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json
```

Edit `config/metadata-instances.json` using the instance ID, Gateway address, and API Key provided by the deployment environment. This file contains credentials and is ignored by Git, so it must not be committed.

Environment variable descriptions are in `.env.example`, and instance registry field descriptions are in `config/metadata-instances.README.md`.

### 3. Start the backend

```bash
pnpm dev
```

Listen on `http://127.0.0.1:8123` by default, with health check as `GET /health`.

### 4. Start the frontend

```bash
cd web
npm run dev
```

Access the browser to `http://127.0.0.1:5173`. The development server forwards `/api/v1` and `/health` to the local Control by default.

Common Commands

| Command | Description |
|------|------|
| `pnpm dev` | Start backend dev server |
| `pnpm build` | Build backend to `dist/` |
| `pnpm typecheck` | Run TypeScript type check |
| `pnpm test` | Run unit tests |
| `pnpm generate:meta-openapi` | Generate Meta OpenAPI docs |
| `pnpm test:panel:e2e` | Run Panel Meta E2E |
| `pnpm test:knowledge:e2e` | Run Knowledge E2E |
| `cd web && npm run dev` | Start frontend dev server |
| `cd web && npm run build` | Build frontend to `web/dist/` |
| `bash scripts/secret-leak-check.sh` | Check for sensitive info leakage |

## Public API

The public entry point for Control is uniformly located at `/api/v1`:

- `/api/v1/meta/*`: Instance, identity, and metadata management
- `/api/v1/skill/*`: Skill management
- `/api/v1/chat-memory/*`: Chat Memory management
- `/api/v1/knowledge/*`: Wiki and Code Graph management
- `/api/v1/agent-overview/*`: Agent asset aggregation
- `/api/v1/agent/*`: Agent lifecycle operations

When interfacing, the public contracts under `docs/api/` and the route registrations in the source code shall prevail. External service interfaces not listed in the public contracts do not fall under Control's compatibility commitments.

Container Deployment

This repository provides the Control single-service image, with the default port being `8123`. The build and run instructions are in `docker/README.md`.

When deploying, `metadata-instances.json` must be provided via a read-only mount, and real API Keys must not be written into the image, example files, or version control.

## Security Requirements

- `user_key` is the user credential, which can only be passed via the request Header and must not be written to logs, documentation, or frontend static assets.
- The `api_key` in the instance registry is only for server-side calls to external services and must not be returned to the browser.
- `.env`, the real instance registry, Smoke environment files, logs, and test reports must not be committed.
- Documentation and examples may only use `example.com`, loopback addresses, and obvious placeholders.
- Run `bash scripts/secret-leak-check.sh --strict` before committing.

If credentials have ever entered the Git history, they should be rotated immediately and the history should be cleaned before publishing the repository.

## Document

- Frontend development: `web/README.md`
- Meta API：`docs/api/meta-api.openapi.yaml`
- Knowledge API：`docs/api/knowledge-panel-api.md`
- Chat Memory API：`docs/api/chat-memory.md`
- Docker：`docker/README.md`
