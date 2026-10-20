/**
 * ComfyUI workflow adapter for the Wan 2.2 14B Image-to-Video API workflow
 * (cloudflare/worker/workflows/wan22_i2v_api.json, exported from ComfyUI's
 * "Save (API Format)").
 *
 * Like comfy.ts (the Wan 2.1 text-to-video adapter), this is deliberately
 * specific to this one workflow's node IDs — not a generic "any workflow"
 * engine. Use this adapter when a character has a reference image on file
 * (character consistency: animate FROM that image), and comfy.ts's text-to-video
 * adapter otherwise.
 *
 * Unlike text-to-video, this workflow needs the starting image to already
 * exist on the ComfyUI server's filesystem before /prompt is submitted — so
 * callers must upload it first with uploadImageToComfy().
 */

export type Wan22I2VParams = {
  /** The filename ComfyUI returned from uploadImageToComfy(). */
  imageFilename: string;
  positivePrompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  /** Clip length in seconds, fed into this workflow's duration*fps length calculation. */
  durationSeconds?: number;
  fps?: number;
  seed?: number;
};

// Node IDs from workflows/wan22_i2v_api.json. Keep this in sync with that file.
// Note the "129:NN" IDs: this workflow was authored as a ComfyUI subgraph, so its
// inner nodes keep the subgraph-qualified ID format even in the flattened API export.
const NODE = {
  LOAD_IMAGE: "97",
  SAVE_VIDEO: "108",
  IMAGE_TO_VIDEO: "129:98",
  POSITIVE_PROMPT: "129:93",
  NEGATIVE_PROMPT: "129:89",
  SAMPLER: "129:86",
  DURATION: "129:161",
  FPS: "129:162",
} as const;

const DEFAULT_NEGATIVE_PROMPT =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

/** Fills in a copy of the loaded workflow template with this job's image/prompt/settings. */
export function buildWan22I2VWorkflow(template: Record<string, any>, params: Wan22I2VParams): Record<string, any> {
  if (!params.imageFilename || !params.imageFilename.trim()) {
    throw new Error("imageFilename is required — upload the reference image to ComfyUI first with uploadImageToComfy().");
  }
  if (!params.positivePrompt || !params.positivePrompt.trim()) {
    throw new Error("positivePrompt is required");
  }
  const wf = JSON.parse(JSON.stringify(template)); // deep clone; never mutate the stored template

  for (const nodeId of Object.values(NODE)) {
    if (!wf[nodeId]) {
      throw new Error(`Workflow is missing expected node "${nodeId}" — this isn't the Wan 2.2 I2V workflow this adapter was written for.`);
    }
  }

  wf[NODE.LOAD_IMAGE].inputs.image = params.imageFilename.trim();
  wf[NODE.POSITIVE_PROMPT].inputs.text = params.positivePrompt.trim();
  wf[NODE.NEGATIVE_PROMPT].inputs.text = params.negativePrompt?.trim() || DEFAULT_NEGATIVE_PROMPT;

  if (params.width) wf[NODE.IMAGE_TO_VIDEO].inputs.width = params.width;
  if (params.height) wf[NODE.IMAGE_TO_VIDEO].inputs.height = params.height;
  if (params.durationSeconds) wf[NODE.DURATION].inputs.value = params.durationSeconds;
  if (params.fps) wf[NODE.FPS].inputs.value = params.fps;

  wf[NODE.SAMPLER].inputs.noise_seed = params.seed ?? Math.floor(Math.random() * 1_000_000_000_000);

  return wf;
}

/** Uploads a reference image to ComfyUI's input folder so a LoadImage node can reference it by filename. */
export async function uploadImageToComfy(
  comfyUrl: string,
  bytes: ArrayBuffer,
  filename: string,
  contentType: string
): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: contentType }), filename);
  form.append("overwrite", "true");
  const res = await fetch(`${comfyUrl.replace(/\/$/, "")}/upload/image`, { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ComfyUI rejected the reference-image upload (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const body = await res.json<{ name?: string }>();
  if (!body.name) throw new Error(`ComfyUI did not return an uploaded filename: ${JSON.stringify(body).slice(0, 300)}`);
  return body.name;
}
