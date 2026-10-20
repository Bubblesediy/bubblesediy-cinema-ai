# BubblesEdiy Cinema AI — Implementation Checklist

## Milestone 1: Local dashboard with real accounts — DONE in this starter
- [x] Authentication: register/login, bcrypt password hashing, JWT sessions.
- [x] Projects are private per account (ownership-checked, not just UI-hidden).
- [x] Create a project from one movie-concept prompt (title, genre, minutes, language, style bible, concept).
- [x] Character bible with locked appearance/wardrobe text.
- [x] Character reference-image upload (PNG/JPEG/WebP, size-limited, stored per character, served back only to the owner).
- [x] Scene planner with character-ID locks (a scene cannot reference a character outside its project).
- [x] Generation-job table: every render attempt becomes a real `queued/processing/completed/failed/cancelled` record with a stage and error message. No fabricated progress or fake success. A second click never queues a duplicate active job.
- [x] Honest production-readiness panel (character bible, reference images, scene plan, concept prompt, GPU server).
- [x] 20 backend tests (`pytest -q` in `backend/`) covering all of the above.

Still to do before calling this milestone fully closed:
- [ ] Install Node.js LTS and Python 3.11+ on your own machine and run the app there.
- [ ] Set a real `JWT_SECRET` in `backend/.env` (a random one is generated per process otherwise, which logs everyone out on every restart).
- [ ] Decide on a real database for anything beyond a single prototype instance — SQLite is fine for local use but has no story for concurrent writers across multiple server processes. Cloudflare D1 or Postgres is the natural next step once this moves off your laptop.
- [ ] Decide on real asset storage (Cloudflare R2 or equivalent) once reference images and generated clips need to survive beyond one machine's disk.

## Milestone 2: Real generation — now implemented in the Cloudflare Worker
- [x] Workflow node-mapping adapters implemented against real, user-supplied ComfyUI API-export workflows:
  - `cloudflare/worker/src/comfy.ts` — Wan 2.1 text-to-video (used whenever a scene's character has no reference image, or no I2V template is uploaded).
  - `cloudflare/worker/src/comfy_i2v.ts` — Wan 2.2 14B image-to-video (used automatically when the scene's first character has at least one reference image AND `workflows/image_to_video.json` has been uploaded to R2 — this is the character-consistency path: it animates from the actual reference image instead of text alone).
- [x] `runGenerate()` in `cloudflare/worker/src/index.ts` does every readiness check (chars, scenes, GPU reachability, workflow files present), then actually submits to ComfyUI's `/prompt` — never fakes a `queued` placeholder.
- [x] `pollRenderJob()` polls ComfyUI's `/history`, and on completion downloads the real rendered file via `/view` and stores it in R2 — exposed as both a manual `POST /projects/:id/jobs/:jobId/poll` endpoint and a Workers Cron Trigger (`scheduled()` in `index.ts`, `[triggers] crons` in `wrangler.toml`, currently every minute) so jobs finish even with the dashboard closed.
- [x] 44 Worker tests (`npm test` in `cloudflare/worker/`), including full submit → poll → complete and submit/poll-failure lifecycles against a mocked ComfyUI (`test/generate-lifecycle.test.ts`, `test/comfy.test.ts`, `test/comfy_i2v.test.ts`).
- [ ] Install ComfyUI on a compatible GPU host: https://github.com/Comfy-Org/ComfyUI
- [ ] Choose a video model only after reviewing its model card, license, GPU requirements, and commercial terms. (The two workflows above assume Wan 2.1/2.2 — swap the templates and adapter node IDs if you use a different model.)
- [ ] Expose that ComfyUI instance via a Cloudflare Tunnel and set `COMFYUI_URL` (Workers run at the edge and cannot reach `localhost`/LAN).
- [ ] Upload the workflow templates to R2 (required: `workflows/image.json`, `workflows/video.json`; optional, enables character-consistency I2V: `workflows/image_to_video.json`), e.g.:
  ```
  wrangler r2 object put bubblesediy-assets/workflows/video.json --file=cloudflare/worker/workflows/wan21_t2v_api.json
  wrangler r2 object put bubblesediy-assets/workflows/image_to_video.json --file=cloudflare/worker/workflows/wan22_i2v_api.json
  ```
  (`workflows/image.json` still needs a still-image workflow of your choice — not included yet, since no image-only API workflow has been supplied.)

## Milestone 3: Character continuity
- [x] Reference images now upload and persist per character (this starter).
- [ ] Record face, hair, age range, body/build, clothing, props, voice, and forbidden changes in more structured fields if free text isn't enough for your workflow.
- [ ] Reuse reference images and supported identity-conditioning methods across shots (model-specific; depends on the worker from Milestone 2).
- [ ] Generate a contact sheet for each scene and reject inconsistent shots before assembly.

## Milestone 4: Short-film assembly
- [ ] Generate a 30-second scene first.
- [ ] Create dialogue and narration using a licensed voice model/voice with permission.
- [ ] Add music and effects with documented commercial rights.
- [ ] Assemble clips with FFmpeg; check frame rate, audio sync, black frames, abrupt cuts, and subtitle timing.
- [ ] Export and watch the complete result before calling the pipeline successful.

## Optional: automatic screenplay breakdown
- [ ] Install Ollama and a capable local model, set `OLLAMA_URL` and `SCREENPLAY_MODEL`.
- [ ] "Generate synopsis from concept" in the dashboard will then turn your one-line concept into a logline + synopsis. It is additive — you can always write the synopsis yourself instead.

## Scale warning
10 quadrillion (10^16) training examples, or anywhere near that many unique video links, is not a practical target — no existing catalog contains that scale of rights-clear, relevant material. Use a smaller, rights-cleared, carefully curated dataset and evaluate results. Fine-tuning a pretrained model for a narrow goal is far more practical than training a foundation video model from scratch.
