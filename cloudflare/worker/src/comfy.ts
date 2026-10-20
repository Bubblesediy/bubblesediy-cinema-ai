/**
 * ComfyUI workflow adapter for the Wan 2.1 Text-to-Video API workflow
 * (cloudflare/worker/workflows/wan21_t2v_api.json, exported from ComfyUI's
 * "Save (API Format)").
 *
 * This is deliberately specific to that one workflow's node IDs, not a
 * generic "any workflow" engine — the spec this project started from was
 * explicit that workflow node mapping is model/workflow-specific and must
 * not be invented. If you swap in a different workflow (a different model,
 * a different resolution node, an image-to-video graph, etc.), update the
 * node IDs below to match it, or add another adapter alongside this one.
 */

export type Wan21Params = {
  positivePrompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  /** Frame count, not seconds — this workflow's EmptyHunyuanLatentVideo node calls it "length". */
  lengthFrames?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
};

// Node IDs from workflows/wan21_t2v_api.json. Keep this in sync with that file.
const NODE = {
  POSITIVE_PROMPT: "6",
  NEGATIVE_PROMPT: "7",
  LATENT_SIZE: "40",
  SAMPLER: "3",
  SAVE_VIDEO: "50",
} as const;

const DEFAULT_NEGATIVE_PROMPT =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

/** Fills in a copy of the loaded workflow template with this job's prompt/settings. */
export function buildWan21Workflow(template: Record<string, any>, params: Wan21Params): Record<string, any> {
  if (!params.positivePrompt || !params.positivePrompt.trim()) {
    throw new Error("positivePrompt is required");
  }
  const wf = JSON.parse(JSON.stringify(template)); // deep clone; never mutate the stored template

  for (const nodeId of [NODE.POSITIVE_PROMPT, NODE.NEGATIVE_PROMPT, NODE.LATENT_SIZE, NODE.SAMPLER, NODE.SAVE_VIDEO]) {
    if (!wf[nodeId]) throw new Error(`Workflow is missing expected node "${nodeId}" — this isn't the Wan 2.1 T2V workflow this adapter was written for.`);
  }

  wf[NODE.POSITIVE_PROMPT].inputs.text = params.positivePrompt.trim();
  wf[NODE.NEGATIVE_PROMPT].inputs.text = params.negativePrompt?.trim() || DEFAULT_NEGATIVE_PROMPT;

  if (params.width) wf[NODE.LATENT_SIZE].inputs.width = params.width;
  if (params.height) wf[NODE.LATENT_SIZE].inputs.height = params.height;
  if (params.lengthFrames) wf[NODE.LATENT_SIZE].inputs.length = params.lengthFrames;

  wf[NODE.SAMPLER].inputs.seed = params.seed ?? Math.floor(Math.random() * 1_000_000_000_000);
  if (params.steps) wf[NODE.SAMPLER].inputs.steps = params.steps;
  if (params.cfg) wf[NODE.SAMPLER].inputs.cfg = params.cfg;

  return wf;
}

export type SubmitResult = { promptId: string };

export async function submitWorkflow(comfyUrl: string, workflow: Record<string, any>, clientId: string): Promise<SubmitResult> {
  const res = await fetch(`${comfyUrl.replace(/\/$/, "")}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ComfyUI rejected the workflow (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const body = await res.json<{ prompt_id?: string; error?: unknown }>();
  if (!body.prompt_id) {
    throw new Error(`ComfyUI did not return a prompt_id: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return { promptId: body.prompt_id };
}

export type HistoryStatus =
  | { state: "pending" }
  | { state: "running" }
  | { state: "completed"; file: { filename: string; subfolder: string; type: string } }
  | { state: "failed"; error: string };

/** Looks for any output entry with a `filename` field under the SaveVideo node, whatever ComfyUI names that output list. */
function findSavedFile(nodeOutputs: Record<string, unknown>): { filename: string; subfolder: string; type: string } | null {
  for (const value of Object.values(nodeOutputs || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && "filename" in item) {
          const f = item as any;
          return { filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" };
        }
      }
    }
  }
  return null;
}

export async function pollHistory(comfyUrl: string, promptId: string): Promise<HistoryStatus> {
  const res = await fetch(`${comfyUrl.replace(/\/$/, "")}/history/${encodeURIComponent(promptId)}`);
  if (!res.ok) throw new Error(`ComfyUI /history returned HTTP ${res.status}`);
  const body = await res.json<Record<string, any>>();
  const entry = body[promptId];
  if (!entry) return { state: "pending" };

  const status = entry.status || {};
  if (status.status_str === "error" || status.completed === false && status.status_str === "error") {
    const messages = Array.isArray(status.messages) ? status.messages.map((m: any) => JSON.stringify(m)).join("; ") : "unknown error";
    return { state: "failed", error: `ComfyUI reported an error: ${messages.slice(0, 500)}` };
  }
  if (!status.completed) return { state: "running" };

  const saveNodeOutput = entry.outputs?.[NODE.SAVE_VIDEO];
  const file = saveNodeOutput ? findSavedFile(saveNodeOutput) : findSavedFile(entry.outputs || {});
  if (!file) return { state: "failed", error: "ComfyUI marked the job complete but no output video file was found in its history response." };
  return { state: "completed", file };
}

export async function fetchOutputFile(comfyUrl: string, file: { filename: string; subfolder: string; type: string }): Promise<ArrayBuffer> {
  const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
  const res = await fetch(`${comfyUrl.replace(/\/$/, "")}/view?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to download rendered output from ComfyUI (HTTP ${res.status})`);
  return res.arrayBuffer();
}
