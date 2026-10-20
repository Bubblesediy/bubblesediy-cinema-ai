import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { fetchMock } from "cloudflare:test";
import { buildWan22I2VWorkflow, uploadImageToComfy } from "../src/comfy_i2v";

// A minimal stand-in for the real wan22_i2v_api.json template: just the node
// IDs this adapter reads/writes.
function minimalTemplate() {
  return {
    "97": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
    "108": { class_type: "SaveVideo", inputs: {} },
    "129:98": { class_type: "WanImageToVideo", inputs: { width: 640, height: 640 } },
    "129:93": { class_type: "CLIPTextEncode", inputs: { text: "placeholder positive" } },
    "129:89": { class_type: "CLIPTextEncode", inputs: { text: "placeholder negative" } },
    "129:86": { class_type: "KSamplerAdvanced", inputs: { noise_seed: 0 } },
    "129:161": { class_type: "PrimitiveFloat", inputs: { value: 5 } },
    "129:162": { class_type: "PrimitiveFloat", inputs: { value: 16 } },
  };
}

describe("buildWan22I2VWorkflow", () => {
  it("fills in the uploaded image filename and the positive prompt", () => {
    const wf = buildWan22I2VWorkflow(minimalTemplate(), {
      imageFilename: "uploaded-ref.png",
      positivePrompt: "a lighthouse at dusk",
    });
    expect(wf["97"].inputs.image).toBe("uploaded-ref.png");
    expect(wf["129:93"].inputs.text).toBe("a lighthouse at dusk");
    expect(wf["129:89"].inputs.text.length).toBeGreaterThan(0);
  });

  it("overrides width/height/duration/fps/seed when given", () => {
    const wf = buildWan22I2VWorkflow(minimalTemplate(), {
      imageFilename: "uploaded-ref.png",
      positivePrompt: "x",
      width: 960,
      height: 540,
      durationSeconds: 3,
      fps: 24,
      seed: 7,
    });
    expect(wf["129:98"].inputs.width).toBe(960);
    expect(wf["129:98"].inputs.height).toBe(540);
    expect(wf["129:161"].inputs.value).toBe(3);
    expect(wf["129:162"].inputs.value).toBe(24);
    expect(wf["129:86"].inputs.noise_seed).toBe(7);
  });

  it("randomizes the seed when none is given", () => {
    const wf1 = buildWan22I2VWorkflow(minimalTemplate(), { imageFilename: "a.png", positivePrompt: "x" });
    const wf2 = buildWan22I2VWorkflow(minimalTemplate(), { imageFilename: "a.png", positivePrompt: "x" });
    expect(wf1["129:86"].inputs.noise_seed).not.toBe(wf2["129:86"].inputs.noise_seed);
  });

  it("never mutates the passed-in template", () => {
    const template = minimalTemplate();
    buildWan22I2VWorkflow(template, { imageFilename: "a.png", positivePrompt: "x" });
    expect(template["97"].inputs.image).toBe("placeholder.png");
  });

  it("rejects a missing image filename or positive prompt", () => {
    expect(() => buildWan22I2VWorkflow(minimalTemplate(), { imageFilename: "", positivePrompt: "x" })).toThrow(/imageFilename/);
    expect(() => buildWan22I2VWorkflow(minimalTemplate(), { imageFilename: "a.png", positivePrompt: "" })).toThrow(/positivePrompt/);
  });

  it("throws a clear, specific error when the template doesn't match this adapter", () => {
    const wrongTemplate = { "1": { class_type: "SomethingElse", inputs: {} } };
    expect(() => buildWan22I2VWorkflow(wrongTemplate, { imageFilename: "a.png", positivePrompt: "x" })).toThrow(/node "97"/);
  });
});

describe("uploadImageToComfy", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  it("uploads and returns ComfyUI's stored filename", async () => {
    fetchMock
      .get("http://comfy.test")
      .intercept({ path: "/upload/image", method: "POST" })
      .reply(200, { name: "job123.png" });

    const name = await uploadImageToComfy("http://comfy.test", new Uint8Array([1, 2, 3]).buffer, "job123.png", "image/png");
    expect(name).toBe("job123.png");
  });

  it("throws with ComfyUI's error body on a non-ok response", async () => {
    fetchMock
      .get("http://comfy.test")
      .intercept({ path: "/upload/image", method: "POST" })
      .reply(415, { error: "unsupported type" });

    await expect(
      uploadImageToComfy("http://comfy.test", new Uint8Array([1]).buffer, "job.png", "image/png")
    ).rejects.toThrow(/415/);
  });
});
