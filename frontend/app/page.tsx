"use client";
import { useEffect, useState } from "react";

type User = { id: string; email: string; display_name: string };
type Project = {
  id: string; title: string; genre: string; target_minutes: number; style_bible: string;
  language: string; concept_prompt: string; synopsis: string; status: string;
};
type Character = { id: string; name: string; appearance_bible: string; wardrobe_lock: string; reference_images: string[] };
type Scene = { id: string; scene_number: number; title: string; description: string; character_ids: string[]; shot_prompt: string; continuity_notes: string };
type Health = {
  ok: boolean; generation_ready: boolean; screenplay_ai_ready: boolean;
  comfyui: { configured: boolean; reachable: boolean; detail: string };
  ollama: { configured: boolean; reachable: boolean; detail: string };
};
type Job = { id: string; job_type: string; status: string; stage: string; error: string; created_at: string; updated_at: string };

const API = "/api";
const TOKEN_KEY = "bubblesediy_token";

async function request(path: string, token: string | null, init?: RequestInit) {
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const headers: Record<string, string> = isFormData
    ? { ...(init?.headers as any || {}) }
    : { "Content-Type": "application/json", ...(init?.headers as any || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const body = isJson ? await res.json().catch(() => ({ detail: "Unexpected server response" })) : await res.blob();
  if (!res.ok) throw new Error((body as any).detail || `HTTP ${res.status}`);
  return body;
}

function AuthScreen({ onAuthed }: { onAuthed: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const path = mode === "login" ? "/auth/login" : "/auth/register";
      const payload = mode === "login" ? { email, password } : { email, password, display_name: displayName };
      const body = await request(path, null, { method: "POST", body: JSON.stringify(payload) });
      onAuthed(body.access_token, body.user);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="top">
        <div>
          <div className="brand">BUBBLESEDIY • FILM LAB</div>
          <h1 className="title">Cinema AI Studio</h1>
          <div className="muted">Sign in to create and manage your private film projects.</div>
        </div>
      </header>
      <section className="grid">
        <article className="card">
          <h2>{mode === "login" ? "Log in" : "Create your account"}</h2>
          {mode === "register" && (
            <div className="field">
              <label>Display name</label>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" />
            </div>
          )}
          <div className="field">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="field">
            <label>Password {mode === "register" && <span className="muted small">(min 8 characters)</span>}</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="row">
            <button className="btn" onClick={submit} disabled={busy || !email || !password}>
              {busy ? "Please wait…" : mode === "login" ? "Log in" : "Register"}
            </button>
            <button className="btn secondary" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
              {mode === "login" ? "Need an account? Register" : "Have an account? Log in"}
            </button>
          </div>
          {error && <p className="status error" style={{ marginTop: 14 }}>{error}</p>}
        </article>
      </section>
      <footer className="footer">
        Passwords are hashed with bcrypt and never stored in plain text. Projects are private to your account.
      </footer>
    </main>
  );
}

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [detail, setDetail] = useState<any>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  const [title, setTitle] = useState("The Last Light");
  const [genre, setGenre] = useState("Science fiction");
  const [minutes, setMinutes] = useState(1);
  const [language, setLanguage] = useState("English");
  const [concept, setConcept] = useState(
    "A marine biologist discovers a mysterious glowing structure deep beneath the ocean."
  );
  const [style, setStyle] = useState(
    "Photorealistic cinematic drama, physically plausible lighting, restrained camera movement, natural skin texture, coherent geography, premium theatrical color grade."
  );

  const [cname, setCname] = useState("Nera Vale");
  const [appearance, setAppearance] = useState(
    "19-year-old courier, warm medium-brown skin, short messy dark-indigo hair, amber-gold eyes, small scar through the outer edge of the right eyebrow, slim athletic build. Keep face shape, eye color, hair and scar identical in every shot."
  );
  const [wardrobe, setWardrobe] = useState(
    "Deep teal cropped courier jacket, cream sleeveless shirt, dark charcoal trousers, red-orange sash, brown ankle boots, fingerless gloves, satchel and brass compass. No wardrobe changes unless explicitly scripted."
  );
  const [uploadTarget, setUploadTarget] = useState<string>("");

  const [sceneTitle, setSceneTitle] = useState("Opening — The City Above the Clouds");
  const [sceneDesc, setSceneDesc] = useState("At dawn, the courier crosses a rain-wet rooftop in a floating coastal city. A distant bell rings one day before it should.");
  const [shot, setShot] = useState("Wide establishing shot, slow controlled push-in, 35mm cinema lens, natural atmospheric haze, realistic wet surfaces, motivated dawn lighting, maintain character reference and wardrobe exactly.");

  // Restore session on load.
  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    if (saved) {
      request("/auth/me", saved)
        .then((u) => { setToken(saved); setUser(u); })
        .catch(() => localStorage.removeItem(TOKEN_KEY))
        .finally(() => setBootstrapped(true));
    } else {
      setBootstrapped(true);
    }
  }, []);

  function onAuthed(newToken: string, newUser: User) {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
    setUser(newUser);
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setProjects([]);
    setDetail(null);
    setSelected("");
  }

  function notify(s: string, bad = false) { setMessage(s); setError(bad); }

  async function refresh() {
    if (!token) return;
    try {
      const h = await request("/health", token); setHealth(h);
      const ps = await request("/projects", token); setProjects(ps);
      if (selected) {
        const d = await request(`/projects/${selected}`, token); setDetail(d);
        const j = await request(`/projects/${selected}/jobs`, token); setJobs(j);
      }
    } catch (e: any) {
      if (e.message.includes("Session expired") || e.message.includes("Invalid session")) logout();
      else notify(e.message, true);
    }
  }
  useEffect(() => {
    if (!token) return;
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selected]);

  async function createProject() {
    try {
      const p = await request("/projects", token, {
        method: "POST",
        body: JSON.stringify({ title, genre, target_minutes: minutes, style_bible: style, language, concept_prompt: concept }),
      });
      setSelected(p.id);
      setDetail({ ...p, characters: [], scenes: [] });
      setJobs([]);
      notify("Project created. Next, define the locked character bible.");
      await refresh();
    } catch (e: any) { notify(e.message, true); }
  }

  async function addCharacter() {
    if (!selected) return notify("Create or select a project first.", true);
    try {
      const c = await request(`/projects/${selected}/characters`, token, {
        method: "POST",
        body: JSON.stringify({
          name: cname, appearance_bible: appearance, wardrobe_lock: wardrobe,
          age_description: "Use only the age and identity details explicitly defined in the appearance bible.",
          reference_images: [],
        }),
      });
      await loadSelected();
      setUploadTarget(c.id);
      notify("Character bible saved. Upload approved reference images below to lock their look in.");
    } catch (e: any) { notify(e.message, true); }
  }

  async function uploadReferenceImage(characterId: string, file: File) {
    if (!selected) return;
    try {
      const form = new FormData();
      form.append("file", file);
      await request(`/projects/${selected}/characters/${characterId}/reference-images`, token, {
        method: "POST",
        body: form, // request() detects FormData and lets the browser set the multipart boundary
      });
      await loadSelected();
      notify("Reference image saved and locked to this character.");
    } catch (e: any) { notify(e.message, true); }
  }

  async function addScene() {
    if (!selected) return notify("Create or select a project first.", true);
    const chars = (detail?.characters || []).map((c: Character) => c.id);
    try {
      await request(`/projects/${selected}/scenes`, token, {
        method: "POST",
        body: JSON.stringify({
          scene_number: (detail?.scenes?.length || 0) + 1, title: sceneTitle, description: sceneDesc,
          character_ids: chars, shot_prompt: shot,
          continuity_notes: "Preserve character identity, facial features, hair, scars, wardrobe, props, screen direction, weather, time of day, and geography. Match the approved reference images.",
        }),
      });
      await loadSelected();
      notify("Scene plan saved with character IDs locked to this project.");
    } catch (e: any) { notify(e.message, true); }
  }

  async function loadSelected() {
    if (!selected) return;
    try {
      const d = await request(`/projects/${selected}`, token); setDetail(d);
      const j = await request(`/projects/${selected}/jobs`, token); setJobs(j);
      await refreshProjectsOnly();
    } catch (e: any) { notify(e.message, true); }
  }
  async function refreshProjectsOnly() { try { setProjects(await request("/projects", token)); } catch {} }

  async function readiness() {
    if (!selected) return notify("Create or select a project first.", true);
    try {
      const r = await request(`/projects/${selected}/production-readiness`, token);
      notify(r.checks.map((c: any) => `${c.ok ? "✓" : "○"} ${c.name}: ${c.detail}`).join("\n"), !r.ready_for_generation);
    } catch (e: any) { notify(e.message, true); }
  }

  async function requestBreakdown() {
    if (!selected) return notify("Create or select a project first.", true);
    try {
      const r = await request(`/projects/${selected}/screenplay/breakdown`, token, { method: "POST" });
      notify("Synopsis generated by your local model.");
      setDetail({ ...detail, synopsis: r.synopsis });
    } catch (e: any) { notify(e.message, true); }
  }

  async function tryGenerate() {
    if (!selected) return notify("Create or select a project first.", true);
    try {
      const r = await request(`/projects/${selected}/generate`, token, { method: "POST" });
      notify(`Job ${r.status.toUpperCase()} (${r.stage || "—"})${r.error ? ": " + r.error : ""}`, r.status === "failed");
      const j = await request(`/projects/${selected}/jobs`, token); setJobs(j);
    } catch (e: any) { notify(e.message, true); }
  }

  async function cancelJob(jobId: string) {
    try { await request(`/projects/${selected}/jobs/${jobId}/cancel`, token, { method: "POST" }); const j = await request(`/projects/${selected}/jobs`, token); setJobs(j); }
    catch (e: any) { notify(e.message, true); }
  }
  async function retryJob(jobId: string) {
    try { await request(`/projects/${selected}/jobs/${jobId}/retry`, token, { method: "POST" }); const j = await request(`/projects/${selected}/jobs`, token); setJobs(j); }
    catch (e: any) { notify(e.message, true); }
  }

  if (!bootstrapped) return <main className="shell"><p className="muted">Loading…</p></main>;
  if (!token || !user) return <AuthScreen onAuthed={onAuthed} />;

  return (
    <main className="shell">
      <header className="top">
        <div>
          <div className="brand">BUBBLESEDIY • FILM LAB</div>
          <h1 className="title">Cinema AI Studio</h1>
          <div className="muted">Signed in as {user.display_name || user.email} · original stories · character continuity · cinematic production pipeline</div>
        </div>
        <div className="row" style={{ alignItems: "center" }}>
          <div className="badge">{health?.generation_ready ? "GPU SERVER ONLINE" : "MODEL SERVER NOT READY"}</div>
          <button className="btn secondary" onClick={logout}>Log out</button>
        </div>
      </header>
      <section className="grid">
        <article className="card">
          <h2>01 / Production status</h2>
          <p className="muted small">The app reports real readiness. It will not claim to render if a GPU model server or tested workflows are missing.</p>
          <div className="checks">
            <div className="check">API: <b className={health?.ok ? "ok" : "no"}>{health?.ok ? "online" : "checking / unavailable"}</b></div>
            <div className="check">GPU / ComfyUI: <b className={health?.comfyui?.reachable ? "ok" : "no"}>{health?.comfyui?.detail || "Checking…"}</b></div>
            <div className="check">Local screenplay model (Ollama): <b className={health?.ollama?.reachable ? "ok" : "no"}>{health?.ollama?.detail || "Checking…"}</b></div>
          </div>
          <div className="field"><label>Existing projects</label>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Select a project…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.title} — {p.genre}</option>)}
            </select>
          </div>
          <div className="row"><button className="btn secondary" onClick={refresh}>Refresh status</button><button className="btn secondary" onClick={readiness}>Check readiness</button></div>
        </article>

        <article className="card">
          <h2>02 / Create a film from one prompt</h2>
          <div className="field"><label>Film title</label><input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>Genre</label>
              <select value={genre} onChange={(e) => setGenre(e.target.value)}>
                {["Science fiction", "Fantasy", "Drama", "Thriller", "Action", "Adventure", "Animation", "Mystery"].map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
            <div className="field" style={{ width: 130 }}><label>Target minutes</label><input type="number" min={1} max={180} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></div>
            <div className="field" style={{ width: 140 }}><label>Language</label><input value={language} onChange={(e) => setLanguage(e.target.value)} /></div>
          </div>
          <div className="field"><label>Movie concept — your one prompt</label><textarea value={concept} onChange={(e) => setConcept(e.target.value)} /></div>
          <div className="field"><label>Visual / directing bible</label><textarea value={style} onChange={(e) => setStyle(e.target.value)} /></div>
          <button className="btn" onClick={createProject}>Create production</button>
          {detail?.synopsis && <div className="item"><b>Synopsis</b><p className="small">{detail.synopsis}</p></div>}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn secondary" onClick={requestBreakdown}>Generate synopsis from concept (local model)</button>
          </div>
        </article>

        <article className="card">
          <h2>03 / Locked character bible</h2>
          <p className="muted small">Stable character IDs, locked appearance/wardrobe descriptions, and approved reference images anchor continuity.</p>
          <div className="field"><label>Character name</label><input value={cname} onChange={(e) => setCname(e.target.value)} /></div>
          <div className="field"><label>Appearance — keep immutable</label><textarea value={appearance} onChange={(e) => setAppearance(e.target.value)} /></div>
          <div className="field"><label>Wardrobe / props lock</label><textarea value={wardrobe} onChange={(e) => setWardrobe(e.target.value)} /></div>
          <button className="btn" onClick={addCharacter}>Save character bible</button>
          <div className="item small muted">{detail?.characters?.length || 0} character(s) in selected project</div>
          {(detail?.characters || []).map((c: Character) => (
            <div className="item" key={c.id}>
              <b>{c.name}</b><div className="muted small">ID: {c.id.slice(0, 12)}…</div>
              <div className="small">{c.appearance_bible}</div>
              <div className="row small" style={{ marginTop: 8 }}>
                <label className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }}>
                  Upload reference image
                  <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadReferenceImage(c.id, f); e.target.value = ""; }} />
                </label>
                <span className="muted small">{c.reference_images.length} approved reference(s)</span>
              </div>
            </div>
          ))}
        </article>

        <article className="card">
          <h2>04 / Scene planner</h2>
          <div className="field"><label>Scene title</label><input value={sceneTitle} onChange={(e) => setSceneTitle(e.target.value)} /></div>
          <div className="field"><label>Action and story beat</label><textarea value={sceneDesc} onChange={(e) => setSceneDesc(e.target.value)} /></div>
          <div className="field"><label>Cinematic shot prompt</label><textarea value={shot} onChange={(e) => setShot(e.target.value)} /></div>
          <button className="btn" onClick={addScene}>Save scene with character locks</button>
          <div className="item small muted">{detail?.scenes?.length || 0} scene(s) planned</div>
          {(detail?.scenes || []).map((s: Scene) => (
            <div className="item" key={s.id}>
              <b>{String(s.scene_number).padStart(2, "0")} — {s.title}</b>
              <p className="muted small">{s.description}</p>
              <div className="small">Locked character IDs: {s.character_ids.length}</div>
            </div>
          ))}
        </article>

        <article className="card full">
          <h2>05 / Generation jobs</h2>
          <p className="muted">Every render attempt is a persisted job record — queued, processing, completed, failed or cancelled — never a fabricated success.</p>
          <div className="row"><button className="btn" onClick={tryGenerate}>Check model setup & attempt render</button>
            <button className="btn secondary" onClick={() => window.open("http://127.0.0.1:8000/docs", "_blank")}>Open backend API docs</button>
          </div>
          {message && <p className={`status ${error ? "error" : ""}`} style={{ marginTop: 14 }}>{message}</p>}
          <div style={{ marginTop: 16 }}>
            {jobs.length === 0 && <p className="muted small">No generation jobs yet for this project.</p>}
            {jobs.map((j) => (
              <div className="item" key={j.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b>{j.job_type.toUpperCase()} — <span className={j.status === "completed" ? "ok" : j.status === "failed" ? "no" : ""}>{j.status}</span></b>
                  <span className="muted small">{new Date(j.updated_at).toLocaleString()}</span>
                </div>
                <div className="small muted">stage: {j.stage || "—"}</div>
                {j.error && <div className="small" style={{ color: "#ffc4c7" }}>{j.error}</div>}
                <div className="row small" style={{ marginTop: 6 }}>
                  {["queued", "processing"].includes(j.status) && <button className="btn secondary" onClick={() => cancelJob(j.id)}>Cancel</button>}
                  {j.status === "failed" && <button className="btn secondary" onClick={() => retryJob(j.id)}>Retry</button>}
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>
      <footer className="footer">
        Build philosophy: repeatable production, stable character IDs, reviewable scene plans, honest readiness checks and job status. A professional result still depends on compatible models, GPU capacity, tested workflows, continuity review, and final editing. Do not train on or use media without the necessary rights.
      </footer>
    </main>
  );
}
