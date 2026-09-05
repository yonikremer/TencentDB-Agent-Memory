# Team Memory Control Web

The Web management interface of Team Memory Control, connecting to the stateless Control service in the same repository.

## Tech Stack

- React 18
- TypeScript
- Vite
- React Router
- Zustand
- Tailwind CSS

## Local Development

Start Control from the repository root directory first:

```bash
pnpm install
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json
pnpm dev
```

Start the frontend again:

```bash
cd web
npm install
cp .env.example .env
npm run dev
```

Open the browser to `http://127.0.0.1:5173`.

Developing an agent

`vite.config.ts` default configuration:

| Request prefix | Default target | Environment variable |
|----------|----------|----------|
| `/api/v1`、`/health` | `http://127.0.0.1:8123` | `VITE_TMC_BACKEND_URL` |
| `/v3` | `http://127.0.0.1:8420` | `VITE_SKILL_GATEWAY_URL` |

To connect to other development environments, use the actual address in the uncommitted `web/.env`. Do not write internal addresses, accounts, or credentials into the README, source code, or tracked environment files.

Build

```bash
npm run build
```

Products are generated to `web/dist/`. Control can host these static files via `UI_DIST_DIR=./web/dist` from the same origin.

## API Boundary

The frontend uses the following Control API:

- `/api/v1/meta/*`
- `/api/v1/skill/*`
- `/api/v1/chat-memory/*`
- `/api/v1/knowledge/*`
- `/api/v1/agent-overview/*`
- `/api/v1/agent/*`

Login credentials are stored in the browser `localStorage`, and business requests are sent via the `X-Tdai-Service-Id` and `X-Tdai-User-Key` Headers. The frontend must not record, display, or upload the complete credentials.

API integration is based on the public contracts under `docs/api/`; external service interfaces not listed in the public contracts are not within the scope of frontend integration.

Common Commands

| Command | Description |
|------|------|
| `npm run dev` | Start dev server |
| `npm run build` | Type check and build |
| `npm run preview` | Preview build output |
| `npm run lint:check` | Check ESLint |
| `npm run format:check` | Check formatting |
