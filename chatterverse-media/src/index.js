const MAX = 95 * 1024 * 1024;
const OK_EXT = /\.(jpe?g|png|webp|gif|heic|mp4|webm|mov|m4v)$/i;
const STAFF = new Set(["support_agent", "moderator", "admin", "super_admin"]);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Admin-Secret,apikey",
  "Access-Control-Max-Age": "86400",
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const goodKey = k => typeof k === "string" && k.length > 0 && k.length < 300 && !k.startsWith("/") && !k.includes("..") && !k.includes("//");
const str = (x, n = 4000) => String(x ?? "").trim().slice(0, n);
const errText = e => String(e?.message || e || "Unexpected error");

function base64UrlJson(part) {
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch { return {}; }
}
function jwtClaims(token) {
  const parts = token.split(".");
  return parts.length === 3 ? base64UrlJson(parts[1]) : {};
}
function authHeader(req) { return req.headers.get("Authorization") || ""; }

async function supa(env, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("apikey", env.SUPABASE_SERVICE_ROLE_KEY);
  headers.set("Authorization", `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...options, headers });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(data?.message || data?.error_description || data?.error || `Supabase request failed (${response.status})`);
  return data;
}
async function currentUser(req, env) {
  const token = authHeader(req).replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY } });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user?.id ? { user, token, claims: jwtClaims(token) } : null;
}
async function canSeeMessageFile(req, env, key) {
  const token = authHeader(req);
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/messages?select=id&limit=1&image_path=eq.${encodeURIComponent(key)}`, { headers: { Authorization: token, apikey: env.SUPABASE_ANON_KEY } });
  if (!r.ok) return false;
  const j = await r.json().catch(() => []);
  return Array.isArray(j) && j.length > 0;
}

async function supportApi(req, env, auth, body) {
  const { user, claims } = auth;
  const action = str(body.action, 40);
  const cid = str(body.conversation_id, 80);
  const message = str(body.message, 4000);
  const getConv = async () => {
    if (!cid) throw new Error("Conversation ID is required.");
    const rows = await supa(env, `/rest/v1/support_conversations?select=*&id=eq.${encodeURIComponent(cid)}&limit=1`);
    if (!rows?.length) throw new Error("Conversation not found.");
    return rows[0];
  };
  const add = async (id, sender, role, text) => {
    await supa(env, "/rest/v1/support_messages", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ conversation_id: id, sender_id: sender, sender_role: role, body: text }) });
    await supa(env, `/rest/v1/support_conversations?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ updated_at: new Date().toISOString() }) });
  };
  const staffCheck = async () => {
    const rows = await supa(env, `/rest/v1/admin_staff?select=role,active&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    const s = rows?.[0];
    if (!s?.active || !STAFF.has(s.role)) throw Object.assign(new Error("Support staff access required."), { status: 403 });
    if ((claims.aal || "aal1") !== "aal2") throw Object.assign(new Error("Complete two-factor authentication first."), { status: 403 });
    return s;
  };
  const firstName = async id => {
    if (!id) return "";
    const account = await supa(env, `/auth/v1/admin/users/${encodeURIComponent(id)}`);
    const m = account?.user_metadata || {};
    const raw = String(m.first_name || m.given_name || m.full_name || m.name || m.display_name || "").trim();
    return raw ? raw.split(/\s+/)[0] : "";
  };

  if (action === "chat") {
    if (!message) return json({ error: "Type a message first." }, 400);
    let c;
    if (cid) {
      c = await getConv();
      if (c.user_id !== user.id) return json({ error: "Not allowed." }, 403);
      if (c.status === "closed") return json({ error: "This conversation is closed." }, 409);
      // Once human support is requested/assigned, route messages to the human queue, never Gemini.
      if (c.status === "waiting_human" || (c.status === "open" && c.assigned_to)) {
        await add(c.id, user.id, "user", message);
        await supa(env, `/rest/v1/support_conversations?id=eq.${encodeURIComponent(c.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "waiting_human", updated_at: new Date().toISOString() }) });
        return json({ conversation_id: c.id, status: "waiting_human", human_support: true });
      }
    } else {
      const rows = await supa(env, "/rest/v1/support_conversations", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ user_id: user.id, subject: "Chatterverse AI support" }) });
      c = rows?.[0];
      if (!c) throw new Error("Could not create support conversation.");
    }
    await add(c.id, user.id, "user", message);
    const key = env.GEMINI_API_KEY;
    if (!key) {
      const reply = "AI support is not configured yet. You can still request human support.";
      await add(c.id, null, "assistant", reply);
      return json({ conversation_id: c.id, reply, ai_configured: false });
    }
    const hist = await supa(env, `/rest/v1/support_messages?select=sender_role,body&conversation_id=eq.${encodeURIComponent(c.id)}&order=created_at.asc&limit=16`);
    const contents = (hist || []).map(m => ({ role: m.sender_role === "assistant" ? "model" : "user", parts: [{ text: m.body }] }));
    const systemPrompt = "You are Chatterverse's friendly support assistant. Answer in the user's language (Tagalog, English, or Taglish). Help with using the social app, profile, messages, posts, stories, clips, privacy, and settings. Be concise. Never claim you performed account actions or accessed private data. Never ask for passwords, OTPs, recovery codes, or payment details. For account-specific matters, offer human support. Do not invent features or policies.";
    const model = env.GEMINI_MODEL || "gemini-2.5-flash";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let response, result;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig: { maxOutputTokens: 500, temperature: 0.4 } }), signal: controller.signal });
      result = await response.json().catch(() => ({}));
    } finally { clearTimeout(timer); }
    if (!response?.ok) {
      console.error("Gemini API error", response?.status, result);
      const fallback = "AI is temporarily unavailable. Please try again or request human support.";
      await add(c.id, null, "assistant", fallback);
      return json({ conversation_id: c.id, reply: fallback, ai_unavailable: true }, 200);
    }
    const reply = str((result.candidates || []).flatMap(c => c.content?.parts || []).map(p => p.text || "").join("\n")) || "I couldn't generate a reply. Please try again.";
    await add(c.id, null, "assistant", reply);
    return json({ conversation_id: c.id, reply, ai_configured: true });
  }

  if (action === "request_human") {
    if (message.length < 8) return json({ error: "Please describe the issue in at least 8 characters." }, 400);
    let c;
    if (cid) {
      c = await getConv();
      if (c.user_id !== user.id) return json({ error: "Not allowed." }, 403);
      if (c.status === "closed") return json({ error: "This conversation is closed." }, 409);
    } else {
      const rows = await supa(env, "/rest/v1/support_conversations", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ user_id: user.id, subject: "Human support request", status: "waiting_human" }) });
      c = rows?.[0];
      if (!c) throw new Error("Could not create support conversation.");
    }
    await add(c.id, user.id, "user", message);
    await supa(env, `/rest/v1/support_conversations?id=eq.${encodeURIComponent(c.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "waiting_human", subject: "Human support request", updated_at: new Date().toISOString() }) });
    return json({ conversation_id: c.id, status: "waiting_human" });
  }

  if (action === "get_messages") {
    const c = await getConv();
    if (c.user_id !== user.id) return json({ error: "Not allowed." }, 403);
    const data = await supa(env, `/rest/v1/support_messages?select=id,sender_id,sender_role,body,created_at&conversation_id=eq.${encodeURIComponent(c.id)}&order=created_at.asc&limit=150`);
    const messages = await Promise.all((data || []).map(async m => ({ ...m, sender_first_name: m.sender_role === "support" ? await firstName(m.sender_id) : "" })));
    return json({ messages, status: c.status });
  }

  await staffCheck();
  if (action === "staff_list") {
    const status = str(body.status, 30);
    let path = "/rest/v1/support_conversations?select=id,user_id,subject,status,updated_at&order=updated_at.desc&limit=100";
    if (status) path += `&status=eq.${encodeURIComponent(status)}`;
    const data = await supa(env, path);
    const conversations = await Promise.all((data || []).map(async c => {
      const u = await supa(env, `/auth/v1/admin/users/${encodeURIComponent(c.user_id)}`).catch(() => null);
      return { ...c, user_email: u?.email || "" };
    }));
    return json({ conversations });
  }
  if (action === "staff_get_thread") {
    const c = await getConv();
    const data = await supa(env, `/rest/v1/support_messages?select=id,sender_id,sender_role,body,created_at&conversation_id=eq.${encodeURIComponent(c.id)}&order=created_at.asc&limit=250`);
    const messages = await Promise.all((data || []).map(async m => ({ ...m, sender_first_name: m.sender_role === "support" ? await firstName(m.sender_id) : "" })));
    return json({ conversation: c, assigned_staff_first_name: c.assigned_to ? await firstName(c.assigned_to) : "", messages });
  }
  if (action === "staff_reply") {
    if (!message) return json({ error: "Reply cannot be empty." }, 400);
    const c = await getConv();
    if (c.status === "closed") return json({ error: "Conversation is closed." }, 409);
    await add(c.id, user.id, "support", message);
    await supa(env, `/rest/v1/support_conversations?id=eq.${encodeURIComponent(c.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "open", assigned_to: user.id, updated_at: new Date().toISOString() }) });
    return json({ ok: true });
  }
  if (action === "staff_close") {
    const c = await getConv();
    await supa(env, `/rest/v1/support_conversations?id=eq.${encodeURIComponent(c.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "closed", updated_at: new Date().toISOString() }) });
    return json({ ok: true });
  }
  return json({ error: "Unknown action." }, 400);
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p.startsWith("/admin/")) {
        if (!env.ADMIN_SECRET || req.headers.get("X-Admin-Secret") !== env.ADMIN_SECRET) return json({ error: "forbidden" }, 403);
        if (req.method === "GET" && p.startsWith("/admin/exists/")) {
          const key = decodeURIComponent(p.slice(14)); if (!goodKey(key)) return json({ error: "bad key" }, 400);
          return json({ exists: !!(await env.BUCKET.head(key)) });
        }
        if (req.method === "PUT" && p.startsWith("/admin/o/")) {
          const key = decodeURIComponent(p.slice(9)); if (!goodKey(key)) return json({ error: "bad key" }, 400);
          await env.BUCKET.put(key, req.body, { httpMetadata: { contentType: req.headers.get("Content-Type") || "application/octet-stream", cacheControl: "public, max-age=31536000, immutable" } });
          return json({ ok: true });
        }
        return json({ error: "not found" }, 404);
      }

      // Support API is separate from media routes and requires a valid signed-in Supabase user.
      if (p === "/support" && req.method === "POST") {
        if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Worker support configuration is incomplete." }, 500);
        const auth = await currentUser(req, env);
        if (!auth) return json({ error: "Session expired. Sign in again." }, 401);
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object") return json({ error: "Invalid request." }, 400);
        return await supportApi(req, env, auth, body);
      }

      const uid = (await currentUser(req, env))?.user?.id;
      if (!uid) return json({ error: "not signed in" }, 401);
      if (req.method === "PUT" && p.startsWith("/o/")) {
        const key = decodeURIComponent(p.slice(3));
        if (!goodKey(key) || !key.startsWith(uid + "/") || key.slice(uid.length + 1).includes("/") || !OK_EXT.test(key)) return json({ error: "bad key" }, 400);
        const ct = req.headers.get("Content-Type") || "";
        if (!/^(image|video)\//.test(ct)) return json({ error: "only images and videos" }, 415);
        const len = Number(req.headers.get("Content-Length") || 0);
        if (len > MAX) return json({ error: "file too large" }, 413);
        await env.BUCKET.put(key, req.body, { httpMetadata: { contentType: ct, cacheControl: "public, max-age=31536000, immutable" } });
        return json({ ok: true, key });
      }
      if (req.method === "POST" && p === "/rm") {
        const b = await req.json().catch(() => null);
        const keys = (b && Array.isArray(b.keys) ? b.keys : []).filter(goodKey).slice(0, 200);
        const allowed = [];
        for (const k of keys) if (k.startsWith(uid + "/") || await canSeeMessageFile(req, env, k)) allowed.push(k);
        if (allowed.length) await env.BUCKET.delete(allowed);
        return json({ ok: true, removed: allowed.length });
      }
      if (req.method === "GET" && p === "/list") {
        const prefix = url.searchParams.get("prefix") || "";
        if (prefix !== uid + "/") return json({ error: "bad prefix" }, 400);
        const names = []; let cursor;
        do { const r = await env.BUCKET.list({ prefix, limit: 1000, cursor }); r.objects.forEach(o => names.push(o.key.slice(prefix.length))); cursor = r.truncated ? r.cursor : null; } while (cursor && names.length < 5000);
        return json({ names });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error("chatterverse-worker", errText(e), e?.stack || "");
      return json({ error: errText(e) }, e?.status || 500);
    }
  }
};
