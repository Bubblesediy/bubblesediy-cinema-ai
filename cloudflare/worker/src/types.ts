export type Env = {
  DB: D1Database;
  ASSETS: R2Bucket;
  APP_NAME: string;
  ALLOWED_ORIGIN: string;
  COMFYUI_URL: string;
  OLLAMA_URL: string;
  SCREENPLAY_MODEL: string;
  ACCESS_TOKEN_EXPIRE_MINUTES: string;
  MAX_UPLOAD_BYTES: string;
  JWT_SECRET: string; // set via `wrangler secret put JWT_SECRET`
};

export type User = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  created_at: string;
};

export type Project = {
  id: string;
  user_id: string;
  title: string;
  genre: string;
  target_minutes: number;
  style_bible: string;
  language: string;
  concept_prompt: string;
  synopsis: string;
  status: string;
  created_at: string;
};

export type Character = {
  id: string;
  project_id: string;
  name: string;
  age_description: string;
  appearance_bible: string;
  wardrobe_lock: string;
  reference_images: string; // JSON-encoded string[] in storage
  created_at: string;
};

export type Scene = {
  id: string;
  project_id: string;
  scene_number: number;
  title: string;
  description: string;
  character_ids: string; // JSON-encoded string[] in storage
  shot_prompt: string;
  continuity_notes: string;
  status: string;
  created_at: string;
};

export type GenerationJob = {
  id: string;
  project_id: string;
  job_type: string;
  status: string;
  stage: string;
  error: string;
  input_json: string;
  output_path: string;
  created_at: string;
  updated_at: string;
};

export const JOB_TYPES = ["image", "video", "voice", "music", "sfx", "assembly"] as const;
export const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};
