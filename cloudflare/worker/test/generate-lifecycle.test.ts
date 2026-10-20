import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { SELF, env, fetchMock } from "cloudflare:test";
import { runGenerate, pollRenderJob } from "../src/index";

// These tests exercise the real runGenerate -> pollRenderJob flow end-to-end
// against a fake ComfyUI server (via undici's fetchMock), so they cover what
// the unit tests in comfy.test.ts can't: that index.ts actually wires the
// adapter's functions into the job lifecycle and persists the right D1/R2
// state at each step, without ever fabricating a result.
//
// Project/character/scene setup goes through SELF.fetch (the real HTTP API),
// but generation itself calls runGenerate/pollRenderJob directly with an env
// that overrides COMFYUI_URL — wrangler.toml's binding is fixed for the whole
// test file, and a request through SELF.fetch always uses that fixed value,
// so there's no way to flip COMFYUI_URL per-test through HTTP alone.

const MINIMAL_WORKFLOW = {
  "6": { class_type: "CLIPTextEncode", inputs: { text: "placeholder positive" } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "placeholder negative" } },
  "40": { class_type: "EmptyHunyuanLatentVideo", inputs: { width: 832, height: 480, length: 81, batch_size: 1 } },
  "3": { class_type: "KSampler", inputs: { seed: 0, steps: 20, cfg: 6 } },
  "50": { class_type: "SaveVideo", inputs: {} },
};

let seq = 0;
function uniqueEmail(prefix: string) {
  seq += 1;
  return `${prefix}${seq}@example.com`;
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } };
}

async function setUpReadyProject() {
  const email = uniqueEmail("lifecycle");
  const regRes = await SELF.fetch("https://worker.test/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password1234" }),
  });
  const { access_token: token } = await regRes.json<any>();

  const project = await (
    await SELF.fetch("https://worker.test/projects", authed(token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Lighthouse Film" }),
    }))
  ).json<any>();

  const character = await (
    await SELF.fetch(`https://worker.test/projects/${project.id}/characters`, authed(token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nera", appearance_bible: "Tall, dark hair." }),
    }))
  ).json<any>();

  await SELF.fetch(`https://worker.test/projects/${project.id}/scenes`, authed(token, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scene_number: 1, title: "Opening", character_ids: [character.id], shot_prompt: "A lighthouse at dusk" }),
  }));

  return { token, project };
}

describe("end-to-end generation lifecycle against a fake ComfyUI", () => {
  let testEnv: typeof env;

  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  beforeEach(async () => {
    // A no-reference-image character takes the text-to-video path (src/comfy.ts), so
    // only workflows/image.json + workflows/video.json need to be present for
    // checkWorkflowsReady() to pass.
    testEnv = { ...env, COMFYUI_URL: "http://comfy.test" };
    await env.ASSETS.put("workflows/image.json", JSON.stringify(MINIMAL_WORKFLOW));
    await env.ASSETS.put("workflows/video.json", JSON.stringify(MINIMAL_WORKFLOW));
  });

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
  });

  it("submits to ComfyUI, then completes once history reports the rendered file", async () => {
    const pool = fetchMock.get("http://comfy.test");
    pool.intercept({ path: "/system_stats" }).reply(200, { ok: true });
    pool.intercept({ path: "/prompt", method: "POST" }).reply(200, { prompt_id: "prompt-1" });

    const { project } = await setUpReadyProject();
    const job = await runGenerate(testEnv, project.id);
    expect(job.status).toBe("processing");
    expect(job.stage).toBe("rendering");
    expect(JSON.parse(job.input_json).prompt_id).toBe("prompt-1");
    expect(JSON.parse(job.input_json).adapter).toBe("wan21_t2v");

    // First poll: still rendering.
    pool.intercept({ path: "/history/prompt-1" }).reply(200, { "prompt-1": { status: { completed: false, status_str: "running" } } });
    const poll1 = await pollRenderJob(testEnv, job);
    expect(poll1.status).toBe("processing");
    expect(poll1.stage).toBe("rendering");

    // Second poll: ComfyUI reports the file is done; worker should download and store it.
    pool.intercept({ path: "/history/prompt-1" }).reply(200, {
      "prompt-1": {
        status: { completed: true, status_str: "success" },
        outputs: { "50": { gifs: [{ filename: "render.mp4", subfolder: "", type: "output" }] } },
      },
    });
    pool
      .intercept({ path: "/view?filename=render.mp4&subfolder=&type=output" })
      .reply(200, Buffer.from(new Uint8Array([9, 9, 9])));

    const poll2 = await pollRenderJob(testEnv, poll1);
    expect(poll2.status).toBe("completed");
    expect(poll2.output_path).toBe(`${project.id}/renders/${job.id}.mp4`);

    const stored = await env.ASSETS.get(poll2.output_path);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
  });

  it("marks the job failed, with ComfyUI's real reason, when submission is rejected", async () => {
    const pool = fetchMock.get("http://comfy.test");
    pool.intercept({ path: "/system_stats" }).reply(200, { ok: true });
    pool.intercept({ path: "/prompt", method: "POST" }).reply(400, { error: "node 6 missing input" });

    const { project } = await setUpReadyProject();
    const job = await runGenerate(testEnv, project.id);
    expect(job.status).toBe("failed");
    expect(job.stage).toBe("submit_failed");
    expect(job.error).toContain("400");
  });

  it("marks the job failed, with ComfyUI's real reason, when history reports an error", async () => {
    const pool = fetchMock.get("http://comfy.test");
    pool.intercept({ path: "/system_stats" }).reply(200, { ok: true });
    pool.intercept({ path: "/prompt", method: "POST" }).reply(200, { prompt_id: "prompt-2" });

    const { project } = await setUpReadyProject();
    const job = await runGenerate(testEnv, project.id);
    expect(job.status).toBe("processing");

    pool.intercept({ path: "/history/prompt-2" }).reply(200, {
      "prompt-2": { status: { completed: false, status_str: "error", messages: [["execution_error", { message: "CUDA OOM" }]] } },
    });
    const polled = await pollRenderJob(testEnv, job);
    expect(polled.status).toBe("failed");
    expect(polled.error).toContain("CUDA OOM");
  });

  it("uses the image-to-video adapter when the scene's character has a reference image and a template is uploaded", async () => {
    const { token, project } = await setUpReadyProject();
    const charList = await (await SELF.fetch(`https://worker.test/projects/${project.id}`, authed(token))).json<any>();
    const character = charList.characters[0];

    // Attach a reference image to the character (real HTTP path, exercises the actual upload route).
    const pngBytes = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0)
    );
    const form = new FormData();
    form.append("file", new Blob([pngBytes], { type: "image/png" }), "ref.png");
    const uploadRes = await SELF.fetch(
      `https://worker.test/projects/${project.id}/characters/${character.id}/reference-images`,
      authed(token, { method: "POST", body: form })
    );
    expect(uploadRes.status).toBe(200);

    // Upload the Wan 2.2 I2V template too, so the i2v path is actually available.
    const I2V_TEMPLATE = {
      "97": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
      "108": { class_type: "SaveVideo", inputs: {} },
      "129:98": { class_type: "WanImageToVideo", inputs: { width: 640, height: 640 } },
      "129:93": { class_type: "CLIPTextEncode", inputs: { text: "placeholder positive" } },
      "129:89": { class_type: "CLIPTextEncode", inputs: { text: "placeholder negative" } },
      "129:86": { class_type: "KSamplerAdvanced", inputs: { noise_seed: 0 } },
      "129:161": { class_type: "PrimitiveFloat", inputs: { value: 5 } },
      "129:162": { class_type: "PrimitiveFloat", inputs: { value: 16 } },
    };
    await env.ASSETS.put("workflows/image_to_video.json", JSON.stringify(I2V_TEMPLATE));

    const pool = fetchMock.get("http://comfy.test");
    pool.intercept({ path: "/system_stats" }).reply(200, { ok: true });
    pool.intercept({ path: "/upload/image", method: "POST" }).reply(200, { name: "uploaded-ref.png" });
    pool.intercept({ path: "/prompt", method: "POST" }).reply(200, { prompt_id: "prompt-i2v" });

    const job = await runGenerate(testEnv, project.id);
    expect(job.status).toBe("processing");
    const input = JSON.parse(job.input_json);
    expect(input.adapter).toBe("wan22_i2v");
    expect(input.prompt_id).toBe("prompt-i2v");
    expect(input.reference_image).toContain(character.id);
  });
});
