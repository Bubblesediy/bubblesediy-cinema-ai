import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { fetchMock } from "cloudflare:test";
import {
  buildWan21Workflow,
  submitWorkflow,
  pollHistory,
  fetchOutputFile,
} from "../src/comfy";

// A minimal stand-in for the real wan21_t2v_api.json template: just enough
// structure (the 5 node IDs this adapter reads/writes) to exercise the logic
// without committing the full multi-hundred-line workflow into the test file.
function minimalTemplate() {
  return {
    "6": { class_type: "CLIPTextEncode", inputs: { text: "placeholder positive" } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "placeholder negative" } },
    "40": { class_type: "EmptyHunyuanLatentVideo", inputs: { width: 832, height: 480, length: 81, batch_size: 1 } },
    "3": { class_type: "KSampler", inputs: { seed: 0, steps: 20, cfg: 6, sampler_name: "uni_pc", scheduler: "simple", denoise: 1 } },
    "50": { class_type: "SaveVideo", inputs: {} },
  };
}

describe("buildWan21Workflow", () => {
  it("fills in the positive prompt and leaves a sensible default negative prompt", () => {
    const wf = buildWan21Workflow(minimalTemplate(), { positivePrompt: "a lighthouse at dusk" });
    expect(wf["6"].inputs.text).toBe("a lighthouse at dusk");
    expect(wf["7"].inputs.text.length).toBeGreaterThan(0);
  });

  it("overrides width/height/length/seed/steps/cfg when given", () => {
    const wf = buildWan21Workflow(minimalTemplate(), {
      positivePrompt: "a lighthouse at dusk",
      width: 1024,
      height: 576,
      lengthFrames: 49,
      seed: 42,
      steps: 30,
      cfg: 7.5,
    });
    expect(wf["40"].inputs.width).toBe(1024);
    expect(wf["40"].inputs.height).toBe(576);
    expect(wf["40"].inputs.length).toBe(49);
    expect(wf["3"].inputs.seed).toBe(42);
    expect(wf["3"].inputs.steps).toBe(30);
    expect(wf["3"].inputs.cfg).toBe(7.5);
  });

  it("randomizes the seed when none is given, rather than reusing the template's", () => {
    const wf1 = buildWan21Workflow(minimalTemplate(), { positivePrompt: "x" });
    const wf2 = buildWan21Workflow(minimalTemplate(), { positivePrompt: "x" });
    expect(wf1["3"].inputs.seed).not.toBe(0);
    expect(wf1["3"].inputs.seed).not.toBe(wf2["3"].inputs.seed);
  });

  it("never mutates the passed-in template", () => {
    const template = minimalTemplate();
    buildWan21Workflow(template, { positivePrompt: "a lighthouse at dusk" });
    expect(template["6"].inputs.text).toBe("placeholder positive");
  });

  it("rejects an empty positive prompt", () => {
    expect(() => buildWan21Workflow(minimalTemplate(), { positivePrompt: "" })).toThrow();
    expect(() => buildWan21Workflow(minimalTemplate(), { positivePrompt: "   " })).toThrow();
  });

  it("throws a clear, specific error when the template doesn't match this adapter", () => {
    const wrongTemplate = { "1": { class_type: "SomethingElse", inputs: {} } };
    expect(() => buildWan21Workflow(wrongTemplate, { positivePrompt: "x" })).toThrow(/node "6"/);
  });
});

describe("ComfyUI HTTP adapter functions", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  it("submitWorkflow posts to /prompt and returns the prompt_id", async () => {
    fetchMock
      .get("http://comfy.test")
      .intercept({ path: "/prompt", method: "POST" })
      .reply(200, { prompt_id: "abc-123" });

    const result = await submitWorkflow("http://comfy.test", { "1": {} }, "client-1");
    expect(result.promptId).toBe("abc-123");
  });

  it("submitWorkflow throws with ComfyUI's error body on a non-ok response", async () => {
    fetchMock
      .get("http://comfy.test")
      .intercept({ path: "/prompt", method: "POST" })
      .reply(400, { error: "invalid prompt: missing node 6" });

    await expect(submitWorkflow("http://comfy.test", { "1": {} }, "client-1")).rejects.toThrow(/400/);
  });

  it("pollHistory reports pending when the prompt isn't in history yet", async () => {
    fetchMock.get("http://comfy.test").intercept({ path: "/history/abc-123" }).reply(200, {});
    const status = await pollHistory("http://comfy.test", "abc-123");
    expect(status.state).toBe("pending");
  });

  it("pollHistory reports running while not yet completed", async () => {
    fetchMock
      .get("http://comfy.test")
      .intercept({ path: "/history/abc-123" })
      .reply(200, { "abc-123": { status: { completed: false, status_str: "running" } } });
    const status = await pollHistory("http://comfy.test", "abc-123");
    expect(status.state).toBe("running");
  });

  it("pollHistory reports the saved file once completed", async () => {
    fetchMock
      .get("http://comfy.test")
      .intercept({ path: "/history/abc-123" })
      .reply(200, {
        "abc-123": {
          status: { completed: true, status_str: "success" },
          outputs: { "50": { gifs: [{ filename: "render.mp4", subfolder: "", type: "output" }] } },
        },
      });
    const status = await pollHistory("http://comfy.test", "abc-123");
    expect(status.state).toBe("completed");
    if (status.state === "completed") expect(status.file.filename).toBe("render.mp4");
  });

  it("pollHistory reports failure with ComfyUI's error detail", async () => {
    fetchMock
      .get("http://comfy.test")
      .intercept({ path: "/history/abc-123" })
      .reply(200, {
        "abc-123": { status: { completed: false, status_str: "error", messages: [["execution_error", { message: "CUDA OOM" }]] } },
      });
    const status = await pollHistory("http://comfy.test", "abc-123");
    expect(status.state).toBe("failed");
    if (status.state === "failed") expect(status.error).toContain("CUDA OOM");
  });

  it("fetchOutputFile downloads the rendered bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    fetchMock
      .get("http://comfy.test")
      .intercept({ path: "/view?filename=render.mp4&subfolder=&type=output" })
      .reply(200, Buffer.from(bytes));
    const buf = await fetchOutputFile("http://comfy.test", { filename: "render.mp4", subfolder: "", type: "output" });
    expect(new Uint8Array(buf)).toEqual(bytes);
  });
});
