"""
End-to-end tests for the BubblesEdiy Cinema AI backend.

Run with:  pytest -q
Uses a fresh temp SQLite file and asset directory per test session so it never
touches a real dev database.
"""
import io
import os
import tempfile
from pathlib import Path

tmp_dir = tempfile.mkdtemp(prefix="bubblesediy_test_")
os.environ["DATABASE_PATH"] = str(Path(tmp_dir) / "test.sqlite3")
os.environ["ASSET_ROOT"] = str(Path(tmp_dir) / "assets")
os.environ["JWT_SECRET"] = "test-secret-not-for-production-use-only-padding"
os.environ["COMFYUI_URL"] = ""
os.environ["OLLAMA_URL"] = ""

from fastapi.testclient import TestClient  # noqa: E402

import app as app_module  # noqa: E402

client = TestClient(app_module.app)


def auth_headers(email="director@example.com", password="correct-horse-battery"):
    r = client.post("/auth/register", json={"email": email, "password": password, "display_name": "Director"})
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


# 1. A user can create a project.
def test_register_and_create_project():
    headers = auth_headers("user1@example.com", "password1234")
    r = client.post(
        "/projects",
        headers=headers,
        json={"title": "The Last Ocean", "genre": "Science fiction", "target_minutes": 2,
              "style_bible": "Photorealistic.", "language": "English",
              "concept_prompt": "A marine biologist finds a glowing structure."},
    )
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "The Last Ocean"


# 2. Duplicate registration is rejected.
def test_duplicate_registration_rejected():
    auth_headers("dup@example.com", "password1234")
    r = client.post("/auth/register", json={"email": "dup@example.com", "password": "password1234"})
    assert r.status_code == 409


# 3. Wrong password is rejected.
def test_login_wrong_password():
    auth_headers("loginuser@example.com", "password1234")
    r = client.post("/auth/login", json={"email": "loginuser@example.com", "password": "nope"})
    assert r.status_code == 401


# 4. Endpoints require auth.
def test_projects_requires_auth():
    r = client.get("/projects")
    assert r.status_code == 401


# 5. Private projects cannot be accessed by unauthorized users.
def test_project_ownership_isolated():
    headers_a = auth_headers("owner@example.com", "password1234")
    headers_b = auth_headers("other@example.com", "password1234")
    p = client.post("/projects", headers=headers_a, json={"title": "Owner Film"}).json()
    r = client.get(f"/projects/{p['id']}", headers=headers_b)
    assert r.status_code == 404  # not leaked as 403; looks identical to "doesn't exist"
    r_list = client.get("/projects", headers=headers_b)
    assert all(proj["id"] != p["id"] for proj in r_list.json())


# 6. Character records persist and are linked to a scene via locked IDs.
def test_character_and_scene_persist():
    headers = auth_headers("story@example.com", "password1234")
    p = client.post("/projects", headers=headers, json={"title": "Story Test"}).json()
    c = client.post(
        f"/projects/{p['id']}/characters",
        headers=headers,
        json={"name": "Nera", "appearance_bible": "Tall, dark hair, amber eyes, small scar.", "wardrobe_lock": "Teal jacket"},
    ).json()
    s = client.post(
        f"/projects/{p['id']}/scenes",
        headers=headers,
        json={"scene_number": 1, "title": "Opening", "character_ids": [c["id"]], "shot_prompt": "Wide shot"},
    )
    assert s.status_code == 200, s.text
    detail = client.get(f"/projects/{p['id']}", headers=headers).json()
    assert detail["characters"][0]["name"] == "Nera"
    assert detail["scenes"][0]["character_ids"] == [c["id"]]


# 7. A scene cannot reference a character from another project / unknown ID.
def test_scene_rejects_unknown_character():
    headers = auth_headers("badref@example.com", "password1234")
    p = client.post("/projects", headers=headers, json={"title": "Bad Ref"}).json()
    r = client.post(
        f"/projects/{p['id']}/scenes",
        headers=headers,
        json={"scene_number": 1, "title": "Opening", "character_ids": ["not-a-real-id"]},
    )
    assert r.status_code == 400


# 8. Reference-image upload: rejects bad type, accepts good, persists on character.
def test_reference_image_upload_validation_and_success():
    headers = auth_headers("imgs@example.com", "password1234")
    p = client.post("/projects", headers=headers, json={"title": "Image Test"}).json()
    c = client.post(
        f"/projects/{p['id']}/characters",
        headers=headers,
        json={"name": "Nera", "appearance_bible": "Tall, dark hair, amber eyes."},
    ).json()

    bad = client.post(
        f"/projects/{p['id']}/characters/{c['id']}/reference-images",
        headers=headers,
        files={"file": ("note.txt", io.BytesIO(b"not an image"), "text/plain")},
    )
    assert bad.status_code == 415

    png_bytes = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
        b"\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x03\x01\x01\x00\x18\xdd\x8d\xb0\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    good = client.post(
        f"/projects/{p['id']}/characters/{c['id']}/reference-images",
        headers=headers,
        files={"file": ("ref.png", io.BytesIO(png_bytes), "image/png")},
    )
    assert good.status_code == 200, good.text
    assert len(good.json()["reference_images"]) == 1

    asset_path = good.json()["reference_images"][0].split("/", 2)[-1]
    served = client.get(f"/projects/{p['id']}/assets/{c['id']}/{asset_path}", headers=headers)
    assert served.status_code == 200
    assert served.content == png_bytes


# 9. Oversized upload is rejected.
def test_reference_image_upload_too_large():
    headers = auth_headers("bigimg@example.com", "password1234")
    os.environ["MAX_UPLOAD_BYTES"] = "10"  # not read dynamically by app module constant; test via direct constant instead
    p = client.post("/projects", headers=headers, json={"title": "Big Image"}).json()
    c = client.post(
        f"/projects/{p['id']}/characters",
        headers=headers,
        json={"name": "Nera", "appearance_bible": "Tall, dark hair, amber eyes."},
    ).json()
    too_big = b"\x89PNG\r\n\x1a\n" + b"0" * (app_module.MAX_UPLOAD_BYTES + 1)
    r = client.post(
        f"/projects/{p['id']}/characters/{c['id']}/reference-images",
        headers=headers,
        files={"file": ("ref.png", io.BytesIO(too_big), "image/png")},
    )
    assert r.status_code == 413


# 10. Generation jobs: missing character/scene -> immediate failed job, not an exception swallowing state.
def test_generate_fails_without_characters_or_scenes():
    headers = auth_headers("gen1@example.com", "password1234")
    p = client.post("/projects", headers=headers, json={"title": "Empty Film"}).json()
    r = client.post(f"/projects/{p['id']}/generate", headers=headers)
    assert r.status_code == 200
    job = r.json()
    assert job["status"] == "failed"
    assert "character" in job["error"].lower()


# 11. Generation jobs: no COMFYUI_URL configured -> failed job with explanatory error, never fake success.
def test_generate_fails_without_model_server():
    headers = auth_headers("gen2@example.com", "password1234")
    p = client.post("/projects", headers=headers, json={"title": "Film"}).json()
    client.post(f"/projects/{p['id']}/characters", headers=headers, json={"name": "A", "appearance_bible": "Tall person with details."})
    chars = client.get(f"/projects/{p['id']}", headers=headers).json()["characters"]
    client.post(f"/projects/{p['id']}/scenes", headers=headers, json={"scene_number": 1, "title": "S1", "character_ids": [chars[0]["id"]]})
    r = client.post(f"/projects/{p['id']}/generate", headers=headers)
    job = r.json()
    assert job["status"] == "failed"
    assert "comfyui_url" in job["error"].lower() or "model server" in job["error"].lower()
    jobs = client.get(f"/projects/{p['id']}/jobs", headers=headers).json()
    assert len(jobs) == 1


# 12. Duplicate submissions are handled safely (no second job queued while one is active).
def test_generate_does_not_duplicate_active_job(monkeypatch):
    headers = auth_headers("gen3@example.com", "password1234")
    p = client.post("/projects", headers=headers, json={"title": "Film"}).json()
    client.post(f"/projects/{p['id']}/characters", headers=headers, json={"name": "A", "appearance_bible": "Tall person with details."})
    chars = client.get(f"/projects/{p['id']}", headers=headers).json()["characters"]
    client.post(f"/projects/{p['id']}/scenes", headers=headers, json={"scene_number": 1, "title": "S1", "character_ids": [chars[0]["id"]]})

    # Force a "queued" job directly, simulating a reachable server + valid workflows,
    # then verify a second /generate call returns the same job instead of creating one.
    with app_module.connect() as db:
        job = app_module._create_job(db, p["id"], "video", "queued", "awaiting_worker", "", {})
    r = client.post(f"/projects/{p['id']}/generate", headers=headers)
    assert r.json()["id"] == job["id"]
    jobs = client.get(f"/projects/{p['id']}/jobs", headers=headers).json()
    assert len(jobs) == 1


# 13. Only a failed job can be retried; retry re-runs the real readiness gate.
def test_retry_only_allowed_on_failed_job():
    headers = auth_headers("gen4@example.com", "password1234")
    p = client.post("/projects", headers=headers, json={"title": "Film"}).json()
    r = client.post(f"/projects/{p['id']}/generate", headers=headers)  # fails: no chars/scenes
    job = r.json()
    assert job["status"] == "failed"
    retry = client.post(f"/projects/{p['id']}/jobs/{job['id']}/retry", headers=headers)
    assert retry.status_code == 200
    assert retry.json()["status"] == "failed"

    with app_module.connect() as db:
        done_job = app_module._create_job(db, p["id"], "image", "completed", "done", "", {})
    retry2 = client.post(f"/projects/{p['id']}/jobs/{done_job['id']}/retry", headers=headers)
    assert retry2.status_code == 409


# 14. Cancel only works on non-terminal jobs.
def test_cancel_job():
    headers = auth_headers("gen5@example.com", "password1234")
    p = client.post("/projects", headers=headers, json={"title": "Film"}).json()
    with app_module.connect() as db:
        job = app_module._create_job(db, p["id"], "video", "queued", "awaiting_worker", "", {})
    r = client.post(f"/projects/{p['id']}/jobs/{job['id']}/cancel", headers=headers)
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"
    r2 = client.post(f"/projects/{p['id']}/jobs/{job['id']}/cancel", headers=headers)
    assert r2.status_code == 409


# 15. Screenplay breakdown is honestly gated when no local LLM is configured.
def test_screenplay_breakdown_requires_ollama():
    headers = auth_headers("script@example.com", "password1234")
    p = client.post(
        "/projects", headers=headers,
        json={"title": "Film", "concept_prompt": "A courier crosses a floating city."},
    ).json()
    r = client.post(f"/projects/{p['id']}/screenplay/breakdown", headers=headers)
    assert r.status_code == 409
    assert "ollama" in r.json()["detail"].lower()


# 16. Screenplay breakdown requires a concept prompt first.
def test_screenplay_breakdown_requires_concept():
    headers = auth_headers("script2@example.com", "password1234")
    p = client.post("/projects", headers=headers, json={"title": "Film"}).json()
    r = client.post(f"/projects/{p['id']}/screenplay/breakdown", headers=headers)
    assert r.status_code == 400


# 17. Secrets never appear in browser-facing responses.
def test_password_hash_never_returned():
    headers = auth_headers("secretcheck@example.com", "password1234")
    r = client.get("/auth/me", headers=headers)
    assert "password" not in r.text.lower()


# 18. Health endpoint reports real, non-fabricated readiness.
def test_health_reports_not_ready_without_servers():
    r = client.get("/health")
    body = r.json()
    assert body["generation_ready"] is False
    assert body["screenplay_ai_ready"] is False


# 19. Data persists across a simulated "restart" (re-reading from the same DB path).
def test_data_persists_after_reconnect():
    headers = auth_headers("persist@example.com", "password1234")
    p = client.post("/projects", headers=headers, json={"title": "Persisted Film"}).json()
    with app_module.connect() as db:
        row = db.execute("SELECT * FROM projects WHERE id=?", (p["id"],)).fetchone()
    assert row is not None
    assert row["title"] == "Persisted Film"


# 20. The asset endpoint refuses path traversal outside a project's own asset folder.
def test_asset_path_traversal_blocked():
    headers = auth_headers("traversal@example.com", "password1234")
    p = client.post("/projects", headers=headers, json={"title": "Film"}).json()
    r = client.get(f"/projects/{p['id']}/assets/../../etc/passwd", headers=headers)
    assert r.status_code in (404, 400)
