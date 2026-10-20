# BubblesEdiy Cinema AI — GitHub Resources

This is a practical, modular stack for building a self-hosted AI filmmaking workflow. These are upstream projects, not components already installed or tested inside this starter. Check each repository's current license, model-card terms, hardware requirements, and commercial-use permissions before use.

## 1. Video generation

- **Wan2.1 (official)** — text-to-video and image-to-video models and inference code: https://github.com/Wan-Video/Wan2.1
- **ComfyUI** — node-based local generation backend; can expose workflows over an API: https://github.com/Comfy-Org/ComfyUI
- **Hugging Face Diffusers** — model pipelines and training/fine-tuning examples: https://github.com/huggingface/diffusers
- **CogVideoX examples in Diffusers** — video generation and fine-tuning reference: https://github.com/huggingface/diffusers/tree/main/examples/cogvideo
- **Open-Sora** — open video-generation research project: https://github.com/hpcaitech/Open-Sora

## 2. Images, character references, and fine-tuning

- **Diffusers training examples** — LoRA and other image-model fine-tuning workflows: https://github.com/huggingface/diffusers/tree/main/examples
- **PEFT** — parameter-efficient fine-tuning utilities: https://github.com/huggingface/peft
- **kohya_ss** — Stable Diffusion training GUI/scripts; review model compatibility and license: https://github.com/bmaltais/kohya_ss

Character consistency is not solved by one GitHub repository alone. Store a character bible, approved reference images, wardrobe/prop locks, scene-specific prompts, and continuity checks. Use reference-image or identity-conditioning features supported by the chosen model/workflow, and reject shots that fail review.

## 3. Speech, transcription, and sound

- **Whisper** — speech recognition/transcription: https://github.com/openai/whisper
- **Piper** — local neural text-to-speech: https://github.com/rhasspy/piper
- **Coqui TTS** — text-to-speech toolkit; inspect model-specific licenses: https://github.com/coqui-ai/TTS
- **FFmpeg** — audio/video assembly, transcoding, muxing, and export: https://github.com/FFmpeg/FFmpeg

Only clone or imitate a real person's voice with clear permission. Check each voice/model license and dataset terms before commercial use.

## 4. Editing and quality checks

- **PySceneDetect** — detect cuts and scene boundaries: https://github.com/Breakthrough/PySceneDetect
- **Real-ESRGAN** — image/video-frame upscaling research implementation: https://github.com/xinntao/Real-ESRGAN
- **RIFE** — frame interpolation: https://github.com/hzwer/ECCV2022-RIFE

Upscaling and interpolation can introduce artifacts; they do not restore details that were never generated correctly.

## 5. Dataset and provenance tooling

- **Hugging Face Datasets** — dataset loading and processing: https://github.com/huggingface/datasets
- **FiftyOne** — inspect, curate, and evaluate visual datasets: https://github.com/voxel51/fiftyone
- **Label Studio** — annotate and review training examples: https://github.com/HumanSignal/label-studio

For every asset, keep a manifest with at least: source URL, creator/rightsholder, license name and URL, date accessed, allowed use (training/commercial/redistribution), attribution requirements, and review status. Do not treat public availability as permission to train on or commercially reuse an asset.

## Recommended first implementation

1. Run this starter's project dashboard and backend.
2. Install ComfyUI on a compatible GPU machine and confirm its API is reachable.
3. Create and test one small image-generation workflow and one short image-to-video workflow.
4. Connect the backend to those workflows; save each prompt, seed, model/version, output path, and provenance record.
5. Generate a 30-second proof-of-concept scene before attempting a feature-length film.
6. Add voice, sound design, FFmpeg assembly, and automated continuity checks only after the video workflow works end-to-end.

## Hardware reality

The Ryzen 3 7320U laptop with 8 GB RAM is suitable for editing the dashboard, writing scripts, and managing project metadata. It is not a practical machine for training large video-generation models or reliably generating high-quality video locally. Use a compatible GPU worker for inference/training; the smaller Wan2.1 model's published VRAM claims still refer to GPU memory, not ordinary system RAM.

## Important scope note

This starter currently provides project/character/scene management and readiness checks. It does **not** yet include a working, tested end-to-end renderer, a preconfigured ComfyUI workflow, or a trained proprietary foundation model. The links above are implementation resources, not proof that those features are already integrated.

## About locally downloaded copies of these repos

If you've downloaded zip snapshots of ComfyUI, Wan2.1, CogVideo, AnimeSR, or the
`anime-offline-database` (the anime metadata project, not video files), they belong on
your **GPU inference worker**, not inside this web-app repository:
- This repo (`BubblesEdiy_Cinema_AI_Starter/`) is the Next.js dashboard + FastAPI
  project/job API described in `README.md`. It runs fine on a laptop with no GPU.
- ComfyUI, Wan2.1 and CogVideo are the actual generation engines — install and run
  them on the compatible GPU machine from `NEXT_STEPS.md` Milestone 2, then point
  this app's `COMFYUI_URL` at it.
- AnimeSR is a frame-upscaling model, relevant only once you have real generated
  footage to upscale (Milestone 4 territory).
- `anime-offline-database` is metadata (titles/IDs), not video content; useful for
  cataloging, not for training or generation on its own.

Committing ~50MB+ of a third-party project's source into this repo would bloat it
for no benefit — clone those upstream repos directly on the machine that will
actually run them, exactly as their own READMEs describe.

## Reference-link indexing

If you want to build a reviewable list of individual video/film reference links (for
the Training Studio idea in your original spec, or just for research), use
`tools/reference-link-indexer/` in this repo instead of the one-off collector scripts
you'd been generating per target size (10k/50k/100k/10M/10B/...). It's one
consolidated, tested tool with a sane default target (2,000 — a size you can actually
review item-by-item) instead of an unreachable one.
