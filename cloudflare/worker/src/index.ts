import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";
import {
  HttpError,
  createAccessToken,
  hashPassword,
  jsonError,
  publicUser,
  requireUser,
  verifyPassword,
} from "./auth";
import {
  ALLOWED_IMAGE_TYPES,
  TERMINAL_JOB_STATUSES,
  type Character,
  type Env,
  type GenerationJob,
  type Project,
  type Scene,
} from "./types";
import { buildWan21Workflow, fetchOutputFile, pollHistory, submitWorkflow } from "./comfy";
import { buildWan22I2VWorkflow, uploadImageToComfy } from "./comfy_i2v";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const mw = cors({ origin: c.env.ALLOWED_ORIGIN || "*", allowMethods: ["GET", "POST", "DELETE", "OPTIONS"] });
  return mw(c, next);
});

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ detail: err.message }, err.status as any);
  }
  console.error(err);
  return c.json({ detail: "Internal server error." }, 500);
});

function now(): string {
  return new Date().toISOString();
}
function uuid(): string {
  return crypto.randomUUID();
}

async function getOwnedProject(c: Context<{ Bindings: Env }>, projectId: string, userId: string): Promise<Project> {
  const project = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first<Project>();
  // Same 404 whether missing or not owned, so a project ID never leaks another user's data.
  if (!project || project.user_id !== userId) throw jsonError(404, "Project not found");
  return project;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post("/auth/register", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string; display_name?: string }>();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const displayName = (body.display_name || "").slice(0, 120);
  if (!email.includes("@")) throw jsonError(422, "A valid email is required.");
  if (password.length < 8) throw jsonError(422, "Password must be at least 8 characters.");

  const existing = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
  if (existing) throw jsonError(409, "An account with this email already exists.");

  const id = uuid();
  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare(
    "INSERT INTO users(id,email,password_hash,display_name,created_at) VALUES(?,?,?,?,?)"
  ).bind(id, email, passwordHash, displayName, now()).run();

  const token = await createAccessToken(c.env, id);
  return c.json({ access_token: token, token_type: "bearer", user: { id, email, display_name: displayName } });
});

app.post("/auth/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<any>();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw jsonError(401, "Incorrect email or password.");
  }
  const token = await createAccessToken(c.env, user.id);
  return c.json({ access_token: token, token_type: "bearer", user: publicUser(user) });
});

app.get("/auth/me", async (c) => {
  const user = await requireUser(c);
  return c.json(publicUser(user));
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
async function pingReachable(url: string, path: string, timeoutMs = 3000): Promise<{ configured: boolean; reachable: boolean; detail: string }> {
  if (!url) return { configured: false, reachable: false, detail: "Not configured" };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const r = await fetch(`${url.replace(/\/$/, "")}${path}`, { signal: controller.signal });
    clearTimeout(t);
    return { configured: true, reachable: r.ok, detail: `Returned HTTP ${r.status}` };
  } catch (exc: any) {
    return { configured: true, reachable: false, detail: `Not reachable: ${exc?.name || "fetch error"}` };
  }
}

async function health(c: Context<{ Bindings: Env }>) {
  const comfy = await pingReachable(c.env.COMFYUI_URL, "/system_stats");
  const ollama = await pingReachable(c.env.OLLAMA_URL, "/api/tags");
  return {
    ok: true,
    app: c.env.APP_NAME,
    comfyui: comfy,
    ollama,
    generation_ready: Boolean(c.env.COMFYUI_URL && comfy.reachable),
    screenplay_ai_ready: Boolean(c.env.OLLAMA_URL && ollama.reachable && c.env.SCREENPLAY_MODEL),
  };
}
app.get("/health", async (c) => c.json(await health(c)));

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
app.get("/projects", async (c) => {
  const user = await requireUser(c);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(user.id).all<Project>();
  return c.json(results);
});

app.post("/projects", async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<Partial<Project>>();
  const title = (body.title || "").trim();
  if (!title || title.length > 160) throw jsonError(422, "Title is required (max 160 characters).");
  const id = uuid();
  const row = {
    id,
    user_id: user.id,
    title,
    genre: (body.genre || "Drama").slice(0, 80),
    target_minutes: Math.min(180, Math.max(1, Number(body.target_minutes || 1))),
    style_bible: (body.style_bible || "").slice(0, 6000),
    language: (body.language || "English").slice(0, 60),
    concept_prompt: (body.concept_prompt || "").slice(0, 4000),
    synopsis: "",
    status: "development",
    created_at: now(),
  };
  await c.env.DB.prepare(
    `INSERT INTO projects(id,user_id,title,genre,target_minutes,style_bible,language,concept_prompt,synopsis,status,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(row.id, row.user_id, row.title, row.genre, row.target_minutes, row.style_bible, row.language, row.concept_prompt, row.synopsis, row.status, row.created_at).run();
  return c.json(row);
});

app.get("/projects/:id", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  const project = await getOwnedProject(c, projectId, user.id);
  const chars = await c.env.DB.prepare("SELECT * FROM characters WHERE project_id = ? ORDER BY created_at").bind(projectId).all<Character>();
  const scenes = await c.env.DB.prepare("SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_number").bind(projectId).all<Scene>();
  return c.json({
    ...project,
    characters: chars.results.map((ch) => ({ ...ch, reference_images: JSON.parse(ch.reference_images) })),
    scenes: scenes.results.map((s) => ({ ...s, character_ids: JSON.parse(s.character_ids) })),
  });
});

app.post("/projects/:id/characters", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  await getOwnedProject(c, projectId, user.id);
  const body = await c.req.json<Partial<Character>>();
  const name = (body.name || "").trim();
  const appearance = (body.appearance_bible || "").trim();
  if (!name || name.length > 100) throw jsonError(422, "Character name is required (max 100 characters).");
  if (appearance.length < 10) throw jsonError(422, "appearance_bible must be at least 10 characters.");
  const id = uuid();
  const row = {
    id,
    project_id: projectId,
    name,
    age_description: (body.age_description || "").slice(0, 300),
    appearance_bible: appearance.slice(0, 5000),
    wardrobe_lock: (body.wardrobe_lock || "").slice(0, 2000),
    reference_images: "[]",
    created_at: now(),
  };
  await c.env.DB.prepare(
    `INSERT INTO characters(id,project_id,name,age_description,appearance_bible,wardrobe_lock,reference_images,created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  ).bind(row.id, row.project_id, row.name, row.age_description, row.appearance_bible, row.wardrobe_lock, row.reference_images, row.created_at).run();
  return c.json({ ...row, reference_images: [], consistency_lock: "reference_and_bible" });
});

app.post("/projects/:id/scenes", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  await getOwnedProject(c, projectId, user.id);
  const body = await c.req.json<any>();
  const sceneNumber = Number(body.scene_number);
  const title = (body.title || "").trim();
  if (!Number.isFinite(sceneNumber) || sceneNumber < 1) throw jsonError(422, "scene_number must be >= 1.");
  if (!title || title.length > 160) throw jsonError(422, "Scene title is required (max 160 characters).");
  const characterIds: string[] = Array.isArray(body.character_ids) ? body.character_ids : [];

  if (characterIds.length > 0) {
    const placeholders = characterIds.map(() => "?").join(",");
    const found = await c.env.DB.prepare(
      `SELECT id FROM characters WHERE project_id = ? AND id IN (${placeholders})`
    ).bind(projectId, ...characterIds).all<{ id: string }>();
    const uniqueRequested = new Set(characterIds);
    if (found.results.length !== uniqueRequested.size) {
      throw jsonError(400, "Every scene character must be defined in this project first.");
    }
  }

  const id = uuid();
  const row = {
    id,
    project_id: projectId,
    scene_number: sceneNumber,
    title,
    description: (body.description || "").slice(0, 6000),
    character_ids: JSON.stringify(characterIds),
    shot_prompt: (body.shot_prompt || "").slice(0, 6000),
    continuity_notes: (body.continuity_notes || "").slice(0, 3000),
    status: "planned",
    created_at: now(),
  };
  await c.env.DB.prepare(
    `INSERT INTO scenes(id,project_id,scene_number,title,description,character_ids,shot_prompt,continuity_notes,status,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).bind(row.id, row.project_id, row.scene_number, row.title, row.description, row.character_ids, row.shot_prompt, row.continuity_notes, row.status, row.created_at).run();
  return c.json({ ...row, character_ids: characterIds });
});

// ---------------------------------------------------------------------------
// Reference-image upload (R2) — character consistency foundation
// ---------------------------------------------------------------------------
app.post("/projects/:id/characters/:characterId/reference-images", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  const characterId = c.req.param("characterId");
  await getOwnedProject(c, projectId, user.id);
  const character = await c.env.DB.prepare(
    "SELECT * FROM characters WHERE id = ? AND project_id = ?"
  ).bind(characterId, projectId).first<Character>();
  if (!character) throw jsonError(404, "Character not found in this project");

  const form = await c.req.formData();
  const uploaded = form.get("file");
  const isFileLike = (v: unknown): v is { type: string; arrayBuffer: () => Promise<ArrayBuffer> } =>
    typeof v === "object" && v !== null && "arrayBuffer" in v && typeof (v as any).arrayBuffer === "function";
  if (!isFileLike(uploaded)) throw jsonError(400, "No file field in the upload.");
  const file = uploaded;

  const ext = ALLOWED_IMAGE_TYPES[file.type.toLowerCase()];
  if (!ext) throw jsonError(415, `Unsupported image type '${file.type}'. Use PNG, JPEG or WebP.`);

  const maxBytes = Number(c.env.MAX_UPLOAD_BYTES || "8388608");
  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw jsonError(400, "Uploaded file is empty.");
  if (buf.byteLength > maxBytes) throw jsonError(413, `Image exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB upload limit.`);

  const key = `${projectId}/${characterId}/${uuid()}${ext}`;
  await c.env.ASSETS.put(key, buf, { httpMetadata: { contentType: file.type } });

  const images: string[] = JSON.parse(character.reference_images);
  images.push(key);
  await c.env.DB.prepare("UPDATE characters SET reference_images = ? WHERE id = ?").bind(JSON.stringify(images), characterId).run();

  return c.json({ character_id: characterId, reference_images: images });
});

app.get("/projects/:id/assets/*", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  await getOwnedProject(c, projectId, user.id);
  const fullPath = c.req.path.split(`/projects/${projectId}/assets/`)[1] || "";
  const key = `${projectId}/${fullPath}`;
  if (!key.startsWith(`${projectId}/`) || fullPath.includes("..")) throw jsonError(400, "Invalid asset path.");
  const obj = await c.env.ASSETS.get(key);
  if (!obj) throw jsonError(404, "Asset not found");
  return new Response(obj.body, {
    headers: { "content-type": obj.httpMetadata?.contentType || "application/octet-stream" },
  });
});

// ---------------------------------------------------------------------------
// Screenplay breakdown — gated on a configured, reachable local LLM (via tunnel)
// ---------------------------------------------------------------------------
app.post("/projects/:id/screenplay/breakdown", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  const project = await getOwnedProject(c, projectId, user.id);
  if (!project.concept_prompt.trim()) {
    throw jsonError(400, "Add a one-line movie concept to this project before requesting a breakdown.");
  }
  if (!c.env.OLLAMA_URL || !c.env.SCREENPLAY_MODEL) {
    throw jsonError(
      409,
      "Automatic screenplay breakdown is not enabled: set OLLAMA_URL (a publicly reachable tunnel to your " +
        "local Ollama instance — Workers cannot reach localhost on your machine) and SCREENPLAY_MODEL. Until " +
        "then, write the synopsis yourself."
    );
  }
  const prompt =
    `You are a screenwriter. Title: ${project.title}. Genre: ${project.genre}. ` +
    `Language: ${project.language}. Target runtime: ${project.target_minutes} minutes.\n` +
    `Concept: ${project.concept_prompt}\nStyle bible: ${project.style_bible}\n\n` +
    "Write a concise logline (1 sentence) followed by a short synopsis (120-200 words). " +
    "Do not include scene numbers or dialogue yet.";
  let text = "";
  try {
    const r = await fetch(`${c.env.OLLAMA_URL.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: c.env.SCREENPLAY_MODEL, prompt, stream: false }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json<{ response?: string }>();
    text = (data.response || "").trim();
  } catch (exc: any) {
    throw jsonError(503, `The local language model did not respond: ${exc?.message || "request failed"}`);
  }
  if (!text) throw jsonError(502, "The local language model returned an empty response.");
  await c.env.DB.prepare("UPDATE projects SET synopsis = ? WHERE id = ?").bind(text, projectId).run();
  return c.json({ project_id: projectId, synopsis: text });
});

// ---------------------------------------------------------------------------
// Production readiness
// ---------------------------------------------------------------------------
app.get("/projects/:id/production-readiness", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  const project = await getOwnedProject(c, projectId, user.id);
  const chars = await c.env.DB.prepare("SELECT * FROM characters WHERE project_id = ?").bind(projectId).all<Character>();
  const scenes = await c.env.DB.prepare("SELECT COUNT(*) as n FROM scenes WHERE project_id = ?").bind(projectId).first<{ n: number }>();
  const h = await health(c);
  const hasReferenceImage = chars.results.some((ch) => JSON.parse(ch.reference_images).length > 0);
  const checks = [
    { name: "Project created", ok: true, detail: project.title },
    { name: "Movie concept", ok: Boolean(project.concept_prompt.trim()), detail: project.concept_prompt.trim() ? "Concept prompt saved" : "No concept prompt yet" },
    { name: "Character bible", ok: chars.results.length > 0, detail: `${chars.results.length} character(s) defined` },
    { name: "Reference images", ok: hasReferenceImage, detail: hasReferenceImage ? "At least one approved reference image" : "No reference images uploaded yet" },
    { name: "Scene plan", ok: (scenes?.n || 0) > 0, detail: `${scenes?.n || 0} scene(s) planned` },
    { name: "GPU/model server", ok: h.generation_ready, detail: h.comfyui.detail },
  ];
  return c.json({
    ready_for_generation: checks.every((x) => x.ok),
    checks,
    next_step: h.generation_ready
      ? "Check that image/video workflow files exist in R2 before queueing generation."
      : "Point COMFYUI_URL at a Cloudflare-Tunnel-exposed, reachable GPU server.",
  });
});

// ---------------------------------------------------------------------------
// Generation jobs
// ---------------------------------------------------------------------------
async function createJob(
  env: Env,
  projectId: string,
  jobType: string,
  status: string,
  stage: string,
  error: string,
  input: Record<string, unknown>
): Promise<GenerationJob> {
  const id = uuid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO generation_jobs(id,project_id,job_type,status,stage,error,input_json,output_path,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, projectId, jobType, status, stage, error, JSON.stringify(input), "", ts, ts).run();
  return { id, project_id: projectId, job_type: jobType, status, stage, error, input_json: JSON.stringify(input), output_path: "", created_at: ts, updated_at: ts };
}

function jobOut(j: GenerationJob) {
  return { ...j, input: JSON.parse(j.input_json) };
}

async function updateJob(
  env: Env,
  jobId: string,
  fields: Partial<Pick<GenerationJob, "status" | "stage" | "error" | "output_path">> & { input?: Record<string, unknown> }
): Promise<GenerationJob> {
  const current = await env.DB.prepare("SELECT * FROM generation_jobs WHERE id = ?").bind(jobId).first<GenerationJob>();
  if (!current) throw jsonError(404, "Job not found");
  const next = {
    status: fields.status ?? current.status,
    stage: fields.stage ?? current.stage,
    error: fields.error ?? current.error,
    output_path: fields.output_path ?? current.output_path,
    input_json: fields.input ? JSON.stringify({ ...JSON.parse(current.input_json), ...fields.input }) : current.input_json,
  };
  await env.DB.prepare(
    "UPDATE generation_jobs SET status=?, stage=?, error=?, output_path=?, input_json=?, updated_at=? WHERE id=?"
  ).bind(next.status, next.stage, next.error, next.output_path, next.input_json, now(), jobId).run();
  return { ...current, ...next, updated_at: now() };
}

app.get("/projects/:id/jobs", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  await getOwnedProject(c, projectId, user.id);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM generation_jobs WHERE project_id = ? ORDER BY created_at DESC"
  ).bind(projectId).all<GenerationJob>();
  return c.json(results.map(jobOut));
});

async function checkWorkflowsReady(env: Env): Promise<string[]> {
  const missing: string[] = [];
  for (const [envKey, r2Key] of [
    ["IMAGE_WORKFLOW", "workflows/image.json"],
    ["VIDEO_WORKFLOW", "workflows/video.json"],
  ] as const) {
    const head = await env.ASSETS.head(r2Key);
    if (!head) missing.push(`${envKey} not found in R2 at ${r2Key}. Upload a tested ComfyUI API workflow there first.`);
  }
  return missing;
}

export async function runGenerate(env: Env, projectId: string): Promise<GenerationJob> {
  const active = await env.DB.prepare(
    "SELECT * FROM generation_jobs WHERE project_id = ? AND job_type = 'video' AND status IN ('queued','processing')"
  ).bind(projectId).first<GenerationJob>();
  if (active) return active;

  const charCount = await env.DB.prepare("SELECT COUNT(*) as n FROM characters WHERE project_id = ?").bind(projectId).first<{ n: number }>();
  const sceneCount = await env.DB.prepare("SELECT COUNT(*) as n FROM scenes WHERE project_id = ?").bind(projectId).first<{ n: number }>();
  if (!charCount?.n || !sceneCount?.n) {
    return createJob(env, projectId, "video", "failed", "preflight", "Define at least one character and one scene before generation.", {});
  }

  if (!env.COMFYUI_URL) {
    return createJob(env, projectId, "video", "failed", "preflight", "Generation is not enabled: set COMFYUI_URL to a Cloudflare-Tunnel-exposed GPU-hosted ComfyUI server.", {});
  }
  const comfyHealth = await pingReachable(env.COMFYUI_URL, "/system_stats", 5000);
  if (!comfyHealth.reachable) {
    return createJob(env, projectId, "video", "failed", "preflight", "The configured model server is unreachable. No generation was started.", {});
  }
  const missing = await checkWorkflowsReady(env);
  if (missing.length > 0) {
    return createJob(env, projectId, "video", "failed", "preflight", "Model workflows are not ready: " + missing.join(" "), {});
  }

  // All readiness checks passed — actually submit to ComfyUI. Uses the first scene by
  // scene_number, and its first linked character for prompt + (if available) a
  // reference image.
  const scene = await env.DB.prepare(
    "SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_number LIMIT 1"
  ).bind(projectId).first<Scene>();
  const project = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first<Project>();
  const positivePrompt = [scene?.shot_prompt, scene?.description, project?.style_bible]
    .filter((s) => s && s.trim())
    .join(" — ")
    .slice(0, 2000);

  const sceneCharacterIds: string[] = scene ? JSON.parse(scene.character_ids || "[]") : [];
  const character = sceneCharacterIds[0]
    ? await env.DB.prepare("SELECT * FROM characters WHERE id = ?").bind(sceneCharacterIds[0]).first<Character>()
    : null;
  const referenceImageKey: string | null = character ? (JSON.parse(character.reference_images || "[]")[0] ?? null) : null;

  const job = await createJob(env, projectId, "video", "processing", "submitting_to_comfy", "", {
    scene_id: scene?.id,
    positive_prompt: positivePrompt,
    character_id: character?.id ?? null,
  });

  try {
    // Character-consistency path: if this scene's character has a reference image on
    // file AND an image-to-video workflow template has been uploaded, animate from
    // that image instead of generating from text alone. Falls back to text-to-video
    // whenever either prerequisite is missing — never a silent/fabricated substitute,
    // just a documented, logged choice of adapter.
    const i2vTemplateObj = referenceImageKey ? await env.ASSETS.get("workflows/image_to_video.json") : null;
    if (referenceImageKey && i2vTemplateObj) {
      const refImageObj = await env.ASSETS.get(referenceImageKey);
      if (!refImageObj) throw new Error(`Reference image ${referenceImageKey} disappeared from R2 before submission.`);
      const imageBytes = await refImageObj.arrayBuffer();
      const contentType = refImageObj.httpMetadata?.contentType || "image/png";
      const ext = contentType.includes("jpeg") ? ".jpg" : contentType.includes("webp") ? ".webp" : ".png";
      const uploadedFilename = await uploadImageToComfy(env.COMFYUI_URL, imageBytes, `${job.id}${ext}`, contentType);

      const template = await i2vTemplateObj.json<Record<string, any>>();
      const wf = buildWan22I2VWorkflow(template, { imageFilename: uploadedFilename, positivePrompt });
      const { promptId } = await submitWorkflow(env.COMFYUI_URL, wf, job.id);
      return updateJob(env, job.id, {
        status: "processing",
        stage: "rendering",
        input: { prompt_id: promptId, adapter: "wan22_i2v", reference_image: referenceImageKey },
      });
    }

    const workflowObj = await env.ASSETS.get("workflows/video.json");
    if (!workflowObj) throw new Error("workflows/video.json disappeared from R2 between the readiness check and submission.");
    const template = await workflowObj.json<Record<string, any>>();
    const wf = buildWan21Workflow(template, { positivePrompt });
    const { promptId } = await submitWorkflow(env.COMFYUI_URL, wf, job.id);
    return updateJob(env, job.id, { status: "processing", stage: "rendering", input: { prompt_id: promptId, adapter: "wan21_t2v" } });
  } catch (exc: any) {
    return updateJob(env, job.id, { status: "failed", stage: "submit_failed", error: exc?.message || "Failed to submit the workflow to ComfyUI." });
  }
}

/** Advances one in-flight job by polling ComfyUI. Called both by the manual poll
 * endpoint and the scheduled handler, so both paths behave identically. */
export async function pollRenderJob(env: Env, job: GenerationJob): Promise<GenerationJob> {
  if (job.job_type !== "video" || job.status !== "processing") return job;
  const input = JSON.parse(job.input_json) as { prompt_id?: string };
  if (!input.prompt_id) {
    return updateJob(env, job.id, { status: "failed", stage: "poll_failed", error: "Job has no ComfyUI prompt_id to poll — it may have failed before submission completed." });
  }
  if (!env.COMFYUI_URL) {
    return updateJob(env, job.id, { status: "failed", stage: "poll_failed", error: "COMFYUI_URL is no longer configured; cannot poll for this job's result." });
  }
  try {
    const status = await pollHistory(env.COMFYUI_URL, input.prompt_id);
    if (status.state === "pending" || status.state === "running") {
      return updateJob(env, job.id, { stage: status.state === "running" ? "rendering" : "queued_on_comfy" });
    }
    if (status.state === "failed") {
      return updateJob(env, job.id, { status: "failed", stage: "render_failed", error: status.error });
    }
    // completed: download the real output bytes and store them in R2 ourselves,
    // rather than linking to ComfyUI directly (which may not be reachable by viewers).
    const bytes = await fetchOutputFile(env.COMFYUI_URL, status.file);
    const ext = status.file.filename.includes(".") ? status.file.filename.slice(status.file.filename.lastIndexOf(".")) : ".mp4";
    const key = `${job.project_id}/renders/${job.id}${ext}`;
    await env.ASSETS.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });
    return updateJob(env, job.id, { status: "completed", stage: "done", output_path: key });
  } catch (exc: any) {
    // A transient network hiccup shouldn't permanently fail a render; leave status as
    // "processing" and let the next poll retry, but record the last error for visibility.
    return updateJob(env, job.id, { stage: "poll_error_will_retry", error: exc?.message || "Poll failed; will retry." });
  }
}

app.post("/projects/:id/generate", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  await getOwnedProject(c, projectId, user.id);
  return c.json(jobOut(await runGenerate(c.env, projectId)));
});

app.post("/projects/:id/jobs/:jobId/cancel", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  const jobId = c.req.param("jobId");
  await getOwnedProject(c, projectId, user.id);
  const job = await c.env.DB.prepare("SELECT * FROM generation_jobs WHERE id = ? AND project_id = ?").bind(jobId, projectId).first<GenerationJob>();
  if (!job) throw jsonError(404, "Job not found");
  if (TERMINAL_JOB_STATUSES.has(job.status)) throw jsonError(409, `Job already ${job.status}; it cannot be cancelled.`);
  await c.env.DB.prepare("UPDATE generation_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(now(), jobId).run();
  const updated = await c.env.DB.prepare("SELECT * FROM generation_jobs WHERE id = ?").bind(jobId).first<GenerationJob>();
  return c.json(jobOut(updated!));
});

app.post("/projects/:id/jobs/:jobId/poll", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  const jobId = c.req.param("jobId");
  await getOwnedProject(c, projectId, user.id);
  const job = await c.env.DB.prepare("SELECT * FROM generation_jobs WHERE id = ? AND project_id = ?").bind(jobId, projectId).first<GenerationJob>();
  if (!job) throw jsonError(404, "Job not found");
  return c.json(jobOut(await pollRenderJob(c.env, job)));
});

app.post("/projects/:id/jobs/:jobId/retry", async (c) => {
  const user = await requireUser(c);
  const projectId = c.req.param("id");
  const jobId = c.req.param("jobId");
  await getOwnedProject(c, projectId, user.id);
  const job = await c.env.DB.prepare("SELECT * FROM generation_jobs WHERE id = ? AND project_id = ?").bind(jobId, projectId).first<GenerationJob>();
  if (!job) throw jsonError(404, "Job not found");
  if (job.status !== "failed") throw jsonError(409, "Only a failed job can be retried.");
  // Retrying re-runs the exact same readiness-gated logic as /generate — it never
  // fabricates success.
  return c.json(jobOut(await runGenerate(c.env, projectId)));
});

app.get("/", (c) => c.json({ app: c.env.APP_NAME, health: "/health" }));

/** Cron-triggered background poll: advances every in-flight render job without
 * requiring the dashboard to stay open. Configure the schedule in wrangler.toml's
 * [triggers] block. */
async function scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM generation_jobs WHERE status = 'processing' ORDER BY updated_at ASC LIMIT 20"
  ).all<GenerationJob>();
  for (const job of results) {
    try {
      await pollRenderJob(env, job);
    } catch (exc) {
      console.error(`scheduled poll failed for job ${job.id}:`, exc);
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
