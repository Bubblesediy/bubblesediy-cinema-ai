import json
import mimetypes
import os
import secrets
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import bcrypt
import jwt
import requests
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, EmailStr, Field

load_dotenv()
APP_NAME = os.getenv("APP_NAME", "BubblesEdiy Cinema AI")
DB_PATH = Path(os.getenv("DATABASE_PATH", "./cinema_ai.sqlite3"))
COMFYUI_URL = os.getenv("COMFYUI_URL", "").rstrip("/")
OLLAMA_URL = os.getenv("OLLAMA_URL", "").rstrip("/")
SCREENPLAY_MODEL = os.getenv("SCREENPLAY_MODEL", "")
WORKFLOW_DIR = Path(__file__).parent / "workflows"
ASSET_ROOT = Path(os.getenv("ASSET_ROOT", "./assets")).resolve()
ASSET_ROOT.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

JWT_SECRET = os.getenv("JWT_SECRET", "")
if not JWT_SECRET:
    # Generated per-process so the server still runs in local dev without a .env,
    # but every restart invalidates existing sessions. Set JWT_SECRET for real use.
    JWT_SECRET = secrets.token_hex(32)
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "10080"))  # 7 days

MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(8 * 1024 * 1024)))  # 8MB
ALLOWED_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}

JOB_TYPES = {"image", "video", "voice", "music", "sfx", "assembly"}
JOB_STATUSES = {"queued", "processing", "completed", "failed", "cancelled"}
TERMINAL_JOB_STATUSES = {"completed", "failed", "cancelled"}

app = FastAPI(title=APP_NAME, version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)


def connect():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def _add_column_if_missing(db, table: str, column: str, ddl: str):
    cols = {row["name"] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def init_db():
    with connect() as db:
        db.executescript(
            """
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL,
          genre TEXT NOT NULL DEFAULT '', target_minutes INTEGER NOT NULL DEFAULT 1,
          style_bible TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'development',
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS characters (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
          age_description TEXT NOT NULL DEFAULT '', appearance_bible TEXT NOT NULL DEFAULT '',
          wardrobe_lock TEXT NOT NULL DEFAULT '', reference_images TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id)
        );
        CREATE TABLE IF NOT EXISTS scenes (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scene_number INTEGER NOT NULL,
          title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          character_ids TEXT NOT NULL DEFAULT '[]', shot_prompt TEXT NOT NULL DEFAULT '',
          continuity_notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planned',
          created_at TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id)
        );
        CREATE TABLE IF NOT EXISTS generation_jobs (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, job_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT '',
          error TEXT NOT NULL DEFAULT '', input_json TEXT NOT NULL DEFAULT '{}',
          output_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, FOREIGN KEY(project_id) REFERENCES projects(id)
        );
        """
        )
        # Columns added after the first release stay backward compatible via migration.
        _add_column_if_missing(db, "projects", "user_id", "user_id TEXT NOT NULL DEFAULT ''")
        _add_column_if_missing(db, "projects", "language", "language TEXT NOT NULL DEFAULT 'English'")
        _add_column_if_missing(db, "projects", "concept_prompt", "concept_prompt TEXT NOT NULL DEFAULT ''")
        _add_column_if_missing(db, "projects", "synopsis", "synopsis TEXT NOT NULL DEFAULT ''")
        db.execute("CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_jobs_project ON generation_jobs(project_id)")


init_db()


def now():
    return datetime.now(timezone.utc).isoformat()


def rowdict(row):
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    display_name: str = Field(default="", max_length=120)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def get_current_user(authorization: Optional[str] = Header(default=None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing or malformed Authorization header.")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Session expired. Log in again.")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid session token.")
    with connect() as db:
        user = db.execute("SELECT * FROM users WHERE id=?", (payload.get("sub"),)).fetchone()
    if not user:
        raise HTTPException(401, "User no longer exists.")
    return rowdict(user)


def public_user(user: dict) -> dict:
    return {"id": user["id"], "email": user["email"], "display_name": user["display_name"]}


@app.post("/auth/register")
def register(data: RegisterIn):
    uid = str(uuid.uuid4())
    with connect() as db:
        existing = db.execute("SELECT 1 FROM users WHERE email=?", (data.email.lower(),)).fetchone()
        if existing:
            raise HTTPException(409, "An account with this email already exists.")
        db.execute(
            "INSERT INTO users(id,email,password_hash,display_name,created_at) VALUES(?,?,?,?,?)",
            (uid, data.email.lower(), hash_password(data.password), data.display_name, now()),
        )
    token = create_access_token(uid)
    return {"access_token": token, "token_type": "bearer", "user": {"id": uid, "email": data.email.lower(), "display_name": data.display_name}}


@app.post("/auth/login")
def login(data: LoginIn):
    with connect() as db:
        user = db.execute("SELECT * FROM users WHERE email=?", (data.email.lower(),)).fetchone()
    if not user or not verify_password(data.password, user["password_hash"]):
        raise HTTPException(401, "Incorrect email or password.")
    token = create_access_token(user["id"])
    return {"access_token": token, "token_type": "bearer", "user": public_user(rowdict(user))}


@app.get("/auth/me")
def me(current_user: dict = Depends(get_current_user)):
    return public_user(current_user)


# ---------------------------------------------------------------------------
# Projects / characters / scenes
# ---------------------------------------------------------------------------
class ProjectIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    genre: str = Field(default="Drama", max_length=80)
    target_minutes: int = Field(default=1, ge=1, le=180)
    style_bible: str = Field(default="", max_length=6000)
    language: str = Field(default="English", max_length=60)
    concept_prompt: str = Field(default="", max_length=4000)


class CharacterIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    age_description: str = Field(default="", max_length=300)
    appearance_bible: str = Field(min_length=10, max_length=5000)
    wardrobe_lock: str = Field(default="", max_length=2000)
    reference_images: list[str] = Field(default_factory=list)


class SceneIn(BaseModel):
    scene_number: int = Field(ge=1, le=10000)
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=6000)
    character_ids: list[str] = Field(default_factory=list)
    shot_prompt: str = Field(default="", max_length=6000)
    continuity_notes: str = Field(default="", max_length=3000)


def get_owned_project(db, project_id: str, user_id: str):
    project = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if not project or project["user_id"] != user_id:
        # Same 404 whether the project is missing or just not owned by this user,
        # so a project ID never reveals another user's data.
        raise HTTPException(404, "Project not found")
    return project


def workflow_path(env_name: str) -> Path:
    name = os.getenv(env_name, "")
    if not name:
        raise HTTPException(409, f"{env_name} is not configured. Export a compatible ComfyUI API workflow and configure this filename.")
    path = (WORKFLOW_DIR / name).resolve()
    if WORKFLOW_DIR.resolve() not in path.parents:
        raise HTTPException(400, "Workflow path must stay inside backend/workflows.")
    if not path.exists():
        raise HTTPException(409, f"Workflow file not found: {name}. Add a model-specific ComfyUI API workflow first.")
    return path


@app.get("/health")
def health():
    comfy = {"configured": bool(COMFYUI_URL), "reachable": False, "detail": "COMFYUI_URL not configured"}
    if COMFYUI_URL:
        try:
            r = requests.get(f"{COMFYUI_URL}/system_stats", timeout=3)
            comfy.update(reachable=r.ok, detail=f"ComfyUI returned HTTP {r.status_code}")
        except requests.RequestException as exc:
            comfy["detail"] = f"ComfyUI is not reachable: {exc.__class__.__name__}"
    ollama = {"configured": bool(OLLAMA_URL), "reachable": False, "detail": "OLLAMA_URL not configured"}
    if OLLAMA_URL:
        try:
            r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=3)
            ollama.update(reachable=r.ok, detail=f"Ollama returned HTTP {r.status_code}")
        except requests.RequestException as exc:
            ollama["detail"] = f"Ollama is not reachable: {exc.__class__.__name__}"
    return {
        "ok": True,
        "app": APP_NAME,
        "database": str(DB_PATH),
        "comfyui": comfy,
        "ollama": ollama,
        "generation_ready": bool(COMFYUI_URL and comfy["reachable"]),
        "screenplay_ai_ready": bool(OLLAMA_URL and ollama["reachable"] and SCREENPLAY_MODEL),
    }


@app.get("/projects")
def list_projects(current_user: dict = Depends(get_current_user)):
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM projects WHERE user_id=? ORDER BY created_at DESC", (current_user["id"],)
        ).fetchall()
    return [rowdict(r) for r in rows]


@app.post("/projects")
def create_project(data: ProjectIn, current_user: dict = Depends(get_current_user)):
    pid = str(uuid.uuid4())
    with connect() as db:
        db.execute(
            """INSERT INTO projects(id,user_id,title,genre,target_minutes,style_bible,language,concept_prompt,status,created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (pid, current_user["id"], data.title, data.genre, data.target_minutes, data.style_bible,
             data.language, data.concept_prompt, "development", now()),
        )
    return {"id": pid, "user_id": current_user["id"], **data.model_dump(), "status": "development"}


@app.get("/projects/{project_id}")
def get_project(project_id: str, current_user: dict = Depends(get_current_user)):
    with connect() as db:
        p = get_owned_project(db, project_id, current_user["id"])
        chars = db.execute("SELECT * FROM characters WHERE project_id=? ORDER BY created_at", (project_id,)).fetchall()
        scenes = db.execute("SELECT * FROM scenes WHERE project_id=? ORDER BY scene_number", (project_id,)).fetchall()
    result = rowdict(p)
    result["characters"] = []
    for c in chars:
        item = rowdict(c)
        item["reference_images"] = json.loads(item["reference_images"])
        result["characters"].append(item)
    result["scenes"] = []
    for s in scenes:
        item = rowdict(s)
        item["character_ids"] = json.loads(item["character_ids"])
        result["scenes"].append(item)
    return result


@app.post("/projects/{project_id}/characters")
def add_character(project_id: str, data: CharacterIn, current_user: dict = Depends(get_current_user)):
    cid = str(uuid.uuid4())
    with connect() as db:
        get_owned_project(db, project_id, current_user["id"])
        db.execute(
            """INSERT INTO characters(id,project_id,name,age_description,appearance_bible,wardrobe_lock,reference_images,created_at)
               VALUES(?,?,?,?,?,?,?,?)""",
            (cid, project_id, data.name, data.age_description, data.appearance_bible,
             data.wardrobe_lock, json.dumps(data.reference_images), now()),
        )
    return {"id": cid, "project_id": project_id, **data.model_dump(), "consistency_lock": "reference_and_bible"}


@app.post("/projects/{project_id}/scenes")
def add_scene(project_id: str, data: SceneIn, current_user: dict = Depends(get_current_user)):
    sid = str(uuid.uuid4())
    with connect() as db:
        get_owned_project(db, project_id, current_user["id"])
        if data.character_ids:
            marks = ",".join("?" for _ in data.character_ids)
            found = db.execute(
                f"SELECT id FROM characters WHERE project_id=? AND id IN ({marks})",
                [project_id, *data.character_ids],
            ).fetchall()
            if len(found) != len(set(data.character_ids)):
                raise HTTPException(400, "Every scene character must be defined in this project first.")
        db.execute(
            """INSERT INTO scenes(id,project_id,scene_number,title,description,character_ids,shot_prompt,continuity_notes,status,created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (sid, project_id, data.scene_number, data.title, data.description,
             json.dumps(data.character_ids), data.shot_prompt, data.continuity_notes, "planned", now()),
        )
    return {"id": sid, "project_id": project_id, **data.model_dump(), "status": "planned"}


# ---------------------------------------------------------------------------
# Character reference-image upload (character consistency foundation)
# ---------------------------------------------------------------------------
@app.post("/projects/{project_id}/characters/{character_id}/reference-images")
async def upload_reference_image(
    project_id: str,
    character_id: str,
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    with connect() as db:
        get_owned_project(db, project_id, current_user["id"])
        character = db.execute(
            "SELECT * FROM characters WHERE id=? AND project_id=?", (character_id, project_id)
        ).fetchone()
        if not character:
            raise HTTPException(404, "Character not found in this project")

        content_type = (file.content_type or "").lower()
        ext = ALLOWED_IMAGE_TYPES.get(content_type)
        if not ext:
            raise HTTPException(415, f"Unsupported image type '{content_type}'. Use PNG, JPEG or WebP.")

        body = await file.read()
        if len(body) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"Image exceeds the {MAX_UPLOAD_BYTES // (1024*1024)}MB upload limit.")
        if len(body) == 0:
            raise HTTPException(400, "Uploaded file is empty.")

        char_dir = ASSET_ROOT / project_id / character_id
        char_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{uuid.uuid4().hex}{ext}"
        (char_dir / filename).write_bytes(body)
        rel_path = f"{project_id}/{character_id}/{filename}"

        images = json.loads(character["reference_images"])
        images.append(rel_path)
        db.execute("UPDATE characters SET reference_images=? WHERE id=?", (json.dumps(images), character_id))

    return {"character_id": character_id, "reference_images": images}


@app.get("/projects/{project_id}/assets/{asset_path:path}")
def get_asset(project_id: str, asset_path: str, current_user: dict = Depends(get_current_user)):
    with connect() as db:
        get_owned_project(db, project_id, current_user["id"])
    full_path = (ASSET_ROOT / project_id / asset_path).resolve()
    project_dir = (ASSET_ROOT / project_id).resolve()
    if project_dir not in full_path.parents or not full_path.is_file():
        raise HTTPException(404, "Asset not found")
    media_type = mimetypes.guess_type(full_path.name)[0] or "application/octet-stream"
    return FileResponse(full_path, media_type=media_type)


# ---------------------------------------------------------------------------
# Screenplay breakdown (local LLM only — never a paid third-party API)
# ---------------------------------------------------------------------------
class BreakdownOut(BaseModel):
    synopsis: str


@app.post("/projects/{project_id}/screenplay/breakdown")
def generate_breakdown(project_id: str, current_user: dict = Depends(get_current_user)):
    with connect() as db:
        project = get_owned_project(db, project_id, current_user["id"])
    if not project["concept_prompt"].strip():
        raise HTTPException(400, "Add a one-line movie concept to this project before requesting a breakdown.")
    if not OLLAMA_URL or not SCREENPLAY_MODEL:
        raise HTTPException(
            409,
            "Automatic screenplay breakdown is not enabled: set OLLAMA_URL and SCREENPLAY_MODEL to a locally "
            "running Ollama instance and installed model. Until then, write the synopsis yourself.",
        )
    prompt = (
        f"You are a screenwriter. Title: {project['title']}. Genre: {project['genre']}. "
        f"Language: {project['language']}. Target runtime: {project['target_minutes']} minutes.\n"
        f"Concept: {project['concept_prompt']}\n"
        f"Style bible: {project['style_bible']}\n\n"
        "Write a concise logline (1 sentence) followed by a short synopsis (120-200 words). "
        "Do not include scene numbers or dialogue yet."
    )
    try:
        r = requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": SCREENPLAY_MODEL, "prompt": prompt, "stream": False},
            timeout=120,
        )
        r.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(503, f"The local language model did not respond: {exc.__class__.__name__}")
    text = (r.json() or {}).get("response", "").strip()
    if not text:
        raise HTTPException(502, "The local language model returned an empty response.")
    with connect() as db:
        db.execute("UPDATE projects SET synopsis=? WHERE id=?", (text, project_id))
    return {"project_id": project_id, "synopsis": text}


# ---------------------------------------------------------------------------
# Generation jobs — real persisted status, never a fabricated "completed"
# ---------------------------------------------------------------------------
def job_dict(row) -> dict:
    item = rowdict(row)
    item["input"] = json.loads(item.pop("input_json"))
    return item


@app.get("/projects/{project_id}/jobs")
def list_jobs(project_id: str, current_user: dict = Depends(get_current_user)):
    with connect() as db:
        get_owned_project(db, project_id, current_user["id"])
        rows = db.execute(
            "SELECT * FROM generation_jobs WHERE project_id=? ORDER BY created_at DESC", (project_id,)
        ).fetchall()
    return [job_dict(r) for r in rows]


def _create_job(db, project_id: str, job_type: str, status: str, stage: str, error: str, input_data: dict) -> dict:
    jid = str(uuid.uuid4())
    ts = now()
    db.execute(
        """INSERT INTO generation_jobs(id,project_id,job_type,status,stage,error,input_json,output_path,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (jid, project_id, job_type, status, stage, error, json.dumps(input_data), "", ts, ts),
    )
    row = db.execute("SELECT * FROM generation_jobs WHERE id=?", (jid,)).fetchone()
    return job_dict(row)


@app.get("/projects/{project_id}/production-readiness")
def readiness(project_id: str, current_user: dict = Depends(get_current_user)):
    with connect() as db:
        project = get_owned_project(db, project_id, current_user["id"])
        chars = db.execute("SELECT * FROM characters WHERE project_id=?", (project_id,)).fetchall()
        scenes = db.execute("SELECT * FROM scenes WHERE project_id=?", (project_id,)).fetchall()
    health_data = health()
    checks = [
        {"name": "Project created", "ok": True, "detail": project["title"]},
        {"name": "Movie concept", "ok": bool(project["concept_prompt"].strip()), "detail": "Concept prompt saved" if project["concept_prompt"].strip() else "No concept prompt yet"},
        {"name": "Character bible", "ok": len(chars) > 0, "detail": f"{len(chars)} character(s) defined"},
        {"name": "Reference images", "ok": any(json.loads(c["reference_images"]) for c in chars), "detail": "At least one approved reference image" if any(json.loads(c["reference_images"]) for c in chars) else "No reference images uploaded yet"},
        {"name": "Scene plan", "ok": len(scenes) > 0, "detail": f"{len(scenes)} scene(s) planned"},
        {"name": "GPU/model server", "ok": health_data["generation_ready"], "detail": health_data["comfyui"]["detail"]},
    ]
    return {
        "ready_for_generation": all(x["ok"] for x in checks),
        "checks": checks,
        "next_step": "Configure a tested model-specific workflow and a reachable private GPU server."
        if not health_data["generation_ready"]
        else "Check that image/video workflows exist before queueing generation.",
    }


@app.post("/projects/{project_id}/check-workflows")
def check_workflows(project_id: str, current_user: dict = Depends(get_current_user)):
    with connect() as db:
        get_owned_project(db, project_id, current_user["id"])
    result: dict[str, Any] = {"project_id": project_id, "workflows": {}}
    for key in ("IMAGE_WORKFLOW", "VIDEO_WORKFLOW"):
        try:
            path = workflow_path(key)
            json.loads(path.read_text(encoding="utf-8"))
            result["workflows"][key] = {"configured": True, "valid_json": True, "file": path.name}
        except HTTPException as exc:
            result["workflows"][key] = {"configured": False, "detail": str(exc.detail)}
        except json.JSONDecodeError:
            result["workflows"][key] = {"configured": True, "valid_json": False, "detail": "Workflow is not valid JSON"}
    return result


@app.post("/projects/{project_id}/generate")
def generate(project_id: str, current_user: dict = Depends(get_current_user)):
    with connect() as db:
        project = get_owned_project(db, project_id, current_user["id"])
        chars = db.execute("SELECT COUNT(*) FROM characters WHERE project_id=?", (project_id,)).fetchone()[0]
        scenes = db.execute("SELECT COUNT(*) FROM scenes WHERE project_id=?", (project_id,)).fetchone()[0]

        # Prevent duplicate expensive jobs: a browser refresh must not queue a second render.
        active = db.execute(
            "SELECT * FROM generation_jobs WHERE project_id=? AND job_type='video' AND status IN ('queued','processing')",
            (project_id,),
        ).fetchone()
        if active:
            return job_dict(active)

        if not chars or not scenes:
            return _create_job(db, project_id, "video", "failed", "preflight", "Define at least one character and one scene before generation.", {})

        if not COMFYUI_URL:
            return _create_job(db, project_id, "video", "failed", "preflight", "Generation is not enabled: set COMFYUI_URL to your private GPU-hosted ComfyUI server.", {})

        try:
            ping = requests.get(f"{COMFYUI_URL}/system_stats", timeout=5)
            ping.raise_for_status()
        except requests.RequestException:
            return _create_job(db, project_id, "video", "failed", "preflight", "The configured model server is unreachable. No generation was started.", {})

        missing = []
        for env_name in ("IMAGE_WORKFLOW", "VIDEO_WORKFLOW"):
            try:
                workflow_path(env_name)
            except HTTPException as exc:
                missing.append(str(exc.detail))
        if missing:
            return _create_job(db, project_id, "video", "failed", "preflight", "Model workflows are not ready: " + " ".join(missing), {})

        # Readiness checks passed, but this starter still does not know the chosen
        # model's node mapping, so it queues an honest, inert job instead of pretending
        # to render. A worker that implements the workflow adapter must pick this up.
        job = _create_job(
            db, project_id, "video", "queued", "awaiting_worker",
            "No connected inference worker is consuming the queue yet. Implement the workflow node-mapping "
            "adapter described in backend/workflows/README.md, then start that worker.",
            {"project_id": project_id},
        )
        return job


@app.post("/projects/{project_id}/jobs/{job_id}/cancel")
def cancel_job(project_id: str, job_id: str, current_user: dict = Depends(get_current_user)):
    with connect() as db:
        get_owned_project(db, project_id, current_user["id"])
        job = db.execute("SELECT * FROM generation_jobs WHERE id=? AND project_id=?", (job_id, project_id)).fetchone()
        if not job:
            raise HTTPException(404, "Job not found")
        if job["status"] in TERMINAL_JOB_STATUSES:
            raise HTTPException(409, f"Job already {job['status']}; it cannot be cancelled.")
        db.execute("UPDATE generation_jobs SET status='cancelled', updated_at=? WHERE id=?", (now(), job_id))
        row = db.execute("SELECT * FROM generation_jobs WHERE id=?", (job_id,)).fetchone()
    return job_dict(row)


@app.post("/projects/{project_id}/jobs/{job_id}/retry")
def retry_job(project_id: str, job_id: str, current_user: dict = Depends(get_current_user)):
    with connect() as db:
        get_owned_project(db, project_id, current_user["id"])
        job = db.execute("SELECT * FROM generation_jobs WHERE id=? AND project_id=?", (job_id, project_id)).fetchone()
        if not job:
            raise HTTPException(404, "Job not found")
        if job["status"] != "failed":
            raise HTTPException(409, "Only a failed job can be retried.")
    # Retrying simply re-runs the same readiness-gated flow; it never fabricates success.
    return generate(project_id, current_user)


@app.get("/")
def root():
    return {"app": APP_NAME, "docs": "/docs", "health": "/health"}
