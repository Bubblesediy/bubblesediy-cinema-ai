# BubblesEdiy Cinema AI — Production Starter

This is a runnable starter for a self-hosted AI film-production pipeline. It is **not** a finished Hollywood-grade generator and does not pretend to generate video without models.

## Included
- Next.js studio dashboard: register/log in, create a film project from one concept prompt, define characters, upload reference images, plan scenes, and inspect production readiness.
- FastAPI backend with SQLite persistence for users, projects, character bibles, scenes and generation jobs.
- Authentication: bcrypt-hashed passwords, JWT bearer sessions, and per-user project ownership (a project is 404, not 403, to anyone but its owner).
- Character consistency fields: immutable character ID, appearance bible, wardrobe, uploaded + stored reference images (PNG/JPEG/WebP, size-limited), and per-scene character locks.
- A real generation-job table: every render attempt is a persisted `queued` / `processing` / `completed` / `failed` / `cancelled` record with a stage and error message — never a fabricated success, and a second click never queues a duplicate job while one is active.
- Explicit readiness checks for a ComfyUI server and user-provided workflow JSON, plus an optional local Ollama check for screenplay-breakdown generation (no paid third-party AI API is ever called).
- 20 passing backend tests (`pytest`) covering auth, ownership isolation, upload validation, job lifecycle and duplicate-submission handling.

## Requirements
- Node.js 20+
- Python 3.10+
- For actual AI video generation: a separate GPU-capable machine/server running ComfyUI with compatible image/video models and workflows.
- FFmpeg for final assembly.
- Your existing laptop can operate the browser/dashboard; it is not suitable for most high-quality video-model inference.

## Run the backend
```bash
cd backend
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
# source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```
On macOS/Linux use `cp .env.example .env` instead of `copy`. Set `JWT_SECRET` in `.env` to a real random value (see the comment in `.env.example`) before anything but local testing — without it, every server restart logs everyone out.

Run the test suite any time you change the backend:
```bash
pytest -q
```

## Run the frontend
In another terminal:
```bash
cd frontend
npm install
copy .env.local.example .env.local
npm run dev
```
Open http://localhost:3000. On macOS/Linux use `cp .env.local.example .env.local`.

## Optional: local screenplay breakdown
Set `OLLAMA_URL` (e.g. `http://127.0.0.1:11434`) and `SCREENPLAY_MODEL` (an installed Ollama model tag) in `backend/.env` to enable "Generate synopsis from concept" in the Create-a-film card. Until both are configured and reachable, that endpoint returns an honest 409 instead of inventing a story. This never calls a paid third-party API.

## Connect a self-hosted model server
Set `COMFYUI_URL` in `backend/.env`, for example `http://127.0.0.1:8188`.
The app checks whether ComfyUI responds. For each model, export a compatible ComfyUI API workflow JSON and put it in `backend/workflows/`.
A workflow is model-specific; this starter deliberately does not invent node IDs or claim a workflow works with an uninstalled model.
Configure `IMAGE_WORKFLOW` and `VIDEO_WORKFLOW` to filenames inside `backend/workflows/`.

## Production architecture
- Frontend: Cloudflare Pages or another static/Next.js-compatible host.
- API: private authenticated server.
- Inference: separate GPU worker; do not expose ComfyUI directly to the public internet.
- Assets: Cloudflare R2 or private object storage.
- Metadata: D1 or PostgreSQL/SQLite for a prototype.
- Queue: Cloudflare Queues or a server-side job queue for long-running renders.

## Character consistency rules
1. Create one character record and keep its stable ID.
2. Attach approved reference images and a locked appearance/wardrobe description.
3. Every scene names character IDs, not free-text variations.
4. Generate a shot/scene first, inspect it, and approve it before continuing.
5. Use reference-image conditioning or a trained adapter/LoRA only when the selected model supports it.
6. Reject/retry scenes that fail human review; no current pipeline can guarantee perfect identity consistency across arbitrary long films.

## Rights and safety
Only train on, download, or render with assets you have rights to use. A publicly accessible movie URL is not permission to use it for commercial AI training. Store source, license, and permission evidence with each training asset.
