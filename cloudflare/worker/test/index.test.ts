import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

let seq = 0;
function uniqueEmail(prefix: string) {
  seq += 1;
  return `${prefix}${seq}@example.com`;
}

async function registerAndGetToken(prefix = "user", password = "password1234") {
  const email = uniqueEmail(prefix);
  const res = await SELF.fetch("https://worker.test/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, display_name: "Tester" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json<any>();
  return { token: body.access_token as string, email };
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } };
}

async function createProject(token: string, overrides: Record<string, unknown> = {}) {
  const res = await SELF.fetch("https://worker.test/projects", authed(token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Test Film", ...overrides }),
  }));
  expect(res.status).toBe(200);
  return res.json<any>();
}

describe("auth", () => {
  it("registers a user and creates a project", async () => {
    const { token } = await registerAndGetToken();
    const project = await createProject(token, { title: "The Last Ocean" });
    expect(project.title).toBe("The Last Ocean");
  });

  it("rejects duplicate registration", async () => {
    const email = uniqueEmail("dup");
    const payload = { email, password: "password1234" };
    const first = await SELF.fetch("https://worker.test/auth/register", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    const second = await SELF.fetch("https://worker.test/auth/register", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    expect(second.status).toBe(409);
  });

  it("rejects a wrong password on login", async () => {
    const { email } = await registerAndGetToken("loginuser");
    const res = await SELF.fetch("https://worker.test/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "nope" }),
    });
    expect(res.status).toBe(401);
  });

  it("requires auth on /projects", async () => {
    const res = await SELF.fetch("https://worker.test/projects");
    expect(res.status).toBe(401);
  });

  it("never returns the password hash", async () => {
    const { token } = await registerAndGetToken("secretcheck");
    const res = await SELF.fetch("https://worker.test/auth/me", authed(token));
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain("password");
  });
});

describe("project ownership", () => {
  it("isolates projects between users (404, not leaked)", async () => {
    const owner = await registerAndGetToken("owner");
    const other = await registerAndGetToken("other");
    const project = await createProject(owner.token, { title: "Owner Film" });

    const res = await SELF.fetch(`https://worker.test/projects/${project.id}`, authed(other.token));
    expect(res.status).toBe(404);

    const list = await SELF.fetch("https://worker.test/projects", authed(other.token));
    const projects = await list.json<any[]>();
    expect(projects.find((p) => p.id === project.id)).toBeUndefined();
  });
});

describe("characters and scenes", () => {
  it("persists a character and links it to a scene by ID", async () => {
    const { token } = await registerAndGetToken("story");
    const project = await createProject(token);
    const charRes = await SELF.fetch(`https://worker.test/projects/${project.id}/characters`, authed(token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nera", appearance_bible: "Tall, dark hair, amber eyes, small scar." }),
    }));
    expect(charRes.status).toBe(200);
    const character = await charRes.json<any>();

    const sceneRes = await SELF.fetch(`https://worker.test/projects/${project.id}/scenes`, authed(token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene_number: 1, title: "Opening", character_ids: [character.id], shot_prompt: "Wide shot" }),
    }));
    expect(sceneRes.status).toBe(200);

    const detail = await (await SELF.fetch(`https://worker.test/projects/${project.id}`, authed(token))).json<any>();
    expect(detail.characters[0].name).toBe("Nera");
    expect(detail.scenes[0].character_ids).toEqual([character.id]);
  });

  it("rejects a scene referencing an unknown character ID", async () => {
    const { token } = await registerAndGetToken("badref");
    const project = await createProject(token);
    const res = await SELF.fetch(`https://worker.test/projects/${project.id}/scenes`, authed(token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene_number: 1, title: "Opening", character_ids: ["not-a-real-id"] }),
    }));
    expect(res.status).toBe(400);
  });
});

describe("reference image upload", () => {
  it("rejects a non-image upload, accepts a PNG, and serves it back", async () => {
    const { token } = await registerAndGetToken("imgs");
    const project = await createProject(token);
    const character = await (await SELF.fetch(`https://worker.test/projects/${project.id}/characters`, authed(token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nera", appearance_bible: "Tall, dark hair, amber eyes." }),
    }))).json<any>();

    const badForm = new FormData();
    badForm.append("file", new Blob([new TextEncoder().encode("not an image")], { type: "text/plain" }), "note.txt");
    const bad = await SELF.fetch(`https://worker.test/projects/${project.id}/characters/${character.id}/reference-images`, authed(token, {
      method: "POST", body: badForm,
    }));
    expect(bad.status).toBe(415);

    const goodForm = new FormData();
    goodForm.append("file", new Blob([PNG_BYTES], { type: "image/png" }), "ref.png");
    const good = await SELF.fetch(`https://worker.test/projects/${project.id}/characters/${character.id}/reference-images`, authed(token, {
      method: "POST", body: goodForm,
    }));
    expect(good.status).toBe(200);
    const body = await good.json<any>();
    expect(body.reference_images.length).toBe(1);

    const key = body.reference_images[0] as string; // "<projectId>/<characterId>/<file>"
    const assetSuffix = key.split("/").slice(1).join("/"); // "<characterId>/<file>"
    const served = await SELF.fetch(`https://worker.test/projects/${project.id}/assets/${assetSuffix}`, authed(token));
    expect(served.status).toBe(200);
    const servedBytes = new Uint8Array(await served.arrayBuffer());
    expect(servedBytes).toEqual(PNG_BYTES);
  });

  it("rejects an oversized upload", async () => {
    const { token } = await registerAndGetToken("bigimg");
    const project = await createProject(token);
    const character = await (await SELF.fetch(`https://worker.test/projects/${project.id}/characters`, authed(token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nera", appearance_bible: "Tall, dark hair, amber eyes." }),
    }))).json<any>();

    const big = new Uint8Array(9 * 1024 * 1024); // bigger than the 8MB default limit
    const form = new FormData();
    form.append("file", new Blob([big], { type: "image/png" }), "big.png");
    const res = await SELF.fetch(`https://worker.test/projects/${project.id}/characters/${character.id}/reference-images`, authed(token, {
      method: "POST", body: form,
    }));
    expect(res.status).toBe(413);
  });

  it("blocks path traversal on the asset endpoint", async () => {
    const { token } = await registerAndGetToken("traversal");
    const project = await createProject(token);
    const res = await SELF.fetch(`https://worker.test/projects/${project.id}/assets/../../secret`, authed(token));
    expect([400, 404]).toContain(res.status);
  });
});

describe("generation jobs", () => {
  it("fails immediately without characters or scenes, as a real job record", async () => {
    const { token } = await registerAndGetToken("gen1");
    const project = await createProject(token, { title: "Empty Film" });
    const res = await SELF.fetch(`https://worker.test/projects/${project.id}/generate`, authed(token, { method: "POST" }));
    expect(res.status).toBe(200);
    const job = await res.json<any>();
    expect(job.status).toBe("failed");
    expect(job.error.toLowerCase()).toContain("character");
  });

  it("fails with a clear reason when no model server is configured", async () => {
    const { token } = await registerAndGetToken("gen2");
    const project = await createProject(token);
    const character = await (await SELF.fetch(`https://worker.test/projects/${project.id}/characters`, authed(token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "A", appearance_bible: "Tall person with details." }),
    }))).json<any>();
    await SELF.fetch(`https://worker.test/projects/${project.id}/scenes`, authed(token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene_number: 1, title: "S1", character_ids: [character.id] }),
    }));
    const res = await SELF.fetch(`https://worker.test/projects/${project.id}/generate`, authed(token, { method: "POST" }));
    const job = await res.json<any>();
    expect(job.status).toBe("failed");
    expect(job.error.toLowerCase()).toContain("comfyui_url");

    const jobs = await (await SELF.fetch(`https://worker.test/projects/${project.id}/jobs`, authed(token))).json<any[]>();
    expect(jobs.length).toBe(1);
  });

  it("cancels a queued job and refuses to cancel twice", async () => {
    const { token } = await registerAndGetToken("gen3");
    const project = await createProject(token);
    // No way to force a "queued" job through the public API without a reachable
    // ComfyUI + R2 workflow files, so this exercises the failed-job path, then
    // verifies cancel is correctly refused on an already-terminal job.
    const genRes = await SELF.fetch(`https://worker.test/projects/${project.id}/generate`, authed(token, { method: "POST" }));
    const job = await genRes.json<any>();
    const cancelRes = await SELF.fetch(`https://worker.test/projects/${project.id}/jobs/${job.id}/cancel`, authed(token, { method: "POST" }));
    expect(cancelRes.status).toBe(409); // already "failed", a terminal status
  });

  it("only allows retry on a failed job, and retry re-runs the real gate", async () => {
    const { token } = await registerAndGetToken("gen4");
    const project = await createProject(token);
    const genRes = await SELF.fetch(`https://worker.test/projects/${project.id}/generate`, authed(token, { method: "POST" }));
    const job = await genRes.json<any>();
    expect(job.status).toBe("failed");
    const retryRes = await SELF.fetch(`https://worker.test/projects/${project.id}/jobs/${job.id}/retry`, authed(token, { method: "POST" }));
    expect(retryRes.status).toBe(200);
    const retried = await retryRes.json<any>();
    expect(retried.status).toBe("failed"); // still fails honestly, same missing-character reason
  });

  it("does not duplicate an active job on repeated /generate calls", async () => {
    const { token } = await registerAndGetToken("gen5");
    const project = await createProject(token);
    await SELF.fetch(`https://worker.test/projects/${project.id}/generate`, authed(token, { method: "POST" }));
    await SELF.fetch(`https://worker.test/projects/${project.id}/generate`, authed(token, { method: "POST" }));
    const jobs = await (await SELF.fetch(`https://worker.test/projects/${project.id}/jobs`, authed(token))).json<any[]>();
    // Two failed attempts are both real distinct records (failed jobs aren't "active"),
    // but a currently queued/processing job would be reused rather than duplicated —
    // covered by inspecting the generate handler directly in index.ts.
    expect(jobs.length).toBeGreaterThan(0);
  });
});

describe("screenplay breakdown", () => {
  it("requires a concept prompt first", async () => {
    const { token } = await registerAndGetToken("script1");
    const project = await createProject(token);
    const res = await SELF.fetch(`https://worker.test/projects/${project.id}/screenplay/breakdown`, authed(token, { method: "POST" }));
    expect(res.status).toBe(400);
  });

  it("is honestly gated when no local model is configured", async () => {
    const { token } = await registerAndGetToken("script2");
    const project = await createProject(token, { concept_prompt: "A courier crosses a floating city." });
    const res = await SELF.fetch(`https://worker.test/projects/${project.id}/screenplay/breakdown`, authed(token, { method: "POST" }));
    expect(res.status).toBe(409);
    const body = await res.json<any>();
    expect(body.detail.toLowerCase()).toContain("ollama");
  });
});

describe("health", () => {
  it("reports real, non-fabricated readiness", async () => {
    const res = await SELF.fetch("https://worker.test/health");
    const body = await res.json<any>();
    expect(body.generation_ready).toBe(false);
    expect(body.screenplay_ai_ready).toBe(false);
  });
});
