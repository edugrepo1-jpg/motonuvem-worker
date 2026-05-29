// Worker do GitHub Actions: baixa SOURCE_URL e sobe pra Pixeldrain,
// depois reporta resultado via CALLBACK_URL (HMAC simples por token).
// Roda em runner Ubuntu — sem dependências externas além do Node 20.

import { createWriteStream, createReadStream, statSync, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const {
  MIRROR_ID, SOURCE_URL, FILE_NAME, FILE_SIZE, CALLBACK_URL,
  CALLBACK_TOKEN, PIXELDRAIN_API_KEY,
} = process.env;

for (const [k, v] of Object.entries({
  MIRROR_ID, SOURCE_URL, FILE_NAME, CALLBACK_URL, CALLBACK_TOKEN, PIXELDRAIN_API_KEY,
})) {
  if (!v) { console.error(`faltando env ${k}`); process.exit(1); }
}

const PIXELDRAIN_BASE = "https://pixeldrain.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function callback(payload) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(CALLBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Worker-Token": CALLBACK_TOKEN },
        body: JSON.stringify(payload),
      });
      const txt = await res.text();
      console.log(`callback ${res.status}: ${txt.slice(0, 200)}`);
      if (res.ok) return;
    } catch (e) {
      console.error("callback erro:", e.message);
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error("callback falhou 5x");
}

// --- Google Drive público (porta da lógica que existe na edge function) ---
function decodeHtmlUrl(v) {
  return String(v || "")
    .replace(/&amp;/g, "&")
    .replace(/&#34;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/\\u003d/gi, "=")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/");
}
function htmlAttr(tag, name) {
  const re = new RegExp(`${name}=["']([^"']*)["']`, "i");
  return decodeHtmlUrl(re.exec(tag)?.[1] || "") || null;
}
function isHtmlContentType(ct) {
  return /(?:^|;)\s*(?:text\/html|application\/xhtml\+xml)/i.test(ct || "");
}
async function assertBinaryResponse(res, context) {
  const reader = res.body?.getReader?.();
  if (!reader) throw new Error(`${context}: resposta sem stream`);
  const first = await reader.read();
  if (first.done || !first.value?.length) throw new Error(`${context}: resposta vazia`);
  const sniff = new TextDecoder().decode(first.value.subarray(0, Math.min(first.value.length, 768))).trimStart().toLowerCase();
  if (sniff.startsWith("<!doctype html") || sniff.startsWith("<html") || sniff.startsWith("<head") || (sniff.startsWith("<?xml") && sniff.includes("html"))) {
    try { await reader.cancel(); } catch {}
    throw new Error(`${context}: URL devolveu HTML (login/aviso)`);
  }
  return new ReadableStream({
    start(controller) { controller.enqueue(first.value); },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) return controller.close();
      controller.enqueue(next.value);
    },
    cancel(reason) { try { reader.cancel(reason); } catch {} },
  });
}
function browserHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    ...extra,
  };
}

function extractPixeldrainFileId(url) {
  try {
    const u = new URL(url);
    if (!/^pixeldrain\.(com|dev)$/i.test(u.hostname)) return null;
    const m = /^\/(?:u|d|api\/file)\/([A-Za-z0-9]+)/i.exec(u.pathname);
    return m?.[1] || null;
  } catch {
    const m = /^https?:\/\/pixeldrain\.(?:com|dev)\/(?:u|d|api\/file)\/([A-Za-z0-9]+)/i.exec(url);
    return m?.[1] || null;
  }
}

function extractDriveInfo(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("drive.google.com") && !u.hostname.includes("drive.usercontent.google.com")) return null;
    const m = /\/file\/d\/([^/?#]+)/.exec(u.pathname);
    const fileId = m?.[1] || u.searchParams.get("id");
    if (!fileId) return null;
    return { fileId, resourceKey: u.searchParams.get("resourcekey") || undefined };
  } catch { return null; }
}

async function fetchWithCookies(url, jar, headers = {}) {
  let current = url;
  for (let hop = 0; hop < 10; hop++) {
    const cookieStr = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(current, {
      method: "GET", redirect: "manual",
      headers: { ...browserHeaders(headers), ...(cookieStr ? { Cookie: cookieStr } : {}) },
    });
    const sc = res.headers.get("set-cookie");
    if (sc) {
      for (const chunk of sc.split(/,(?=\s*[^;,\s]+=)/)) {
        const pair = chunk.trim().split(";")[0];
        const eq = pair.indexOf("=");
        if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, current).toString();
      try { await res.body?.cancel?.(); } catch {}
      continue;
    }
    return res;
  }
  throw new Error("muitos redirects");
}

function drivePublicUrl(fileId, resourceKey, confirm) {
  const params = new URLSearchParams({ export: "download", id: fileId });
  if (confirm) params.set("confirm", confirm);
  if (resourceKey) params.set("resourcekey", resourceKey);
  return `https://drive.google.com/uc?${params}`;
}
function driveCandidates(html, fileId, resourceKey) {
  const out = new Set();
  const add = (u) => { if (u) out.add(u); };
  for (const form of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const formHtml = form[0];
    const action = htmlAttr(formHtml, "action");
    if (!action) continue;
    const params = new URLSearchParams();
    for (const input of formHtml.matchAll(/<input\b[^>]*>/gi)) {
      const name = htmlAttr(input[0], "name");
      if (name) params.set(name, htmlAttr(input[0], "value") || "");
    }
    if (!params.has("id")) params.set("id", fileId);
    if (resourceKey && !params.has("resourcekey")) params.set("resourcekey", resourceKey);
    add(`${new URL(action, "https://drive.google.com").toString()}?${params}`);
  }
  const confirm = /name=["']confirm["']\s+value=["']([^"']+)/i.exec(html)?.[1]
    || /[?&]confirm=([^&"']+)/i.exec(html)?.[1]
    || /download_warning[^=]*=([^;"'&]+)/i.exec(html)?.[1];
  if (confirm) add(drivePublicUrl(fileId, resourceKey, decodeURIComponent(confirm)));
  add(drivePublicUrl(fileId, resourceKey, "t"));
  add(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t${resourceKey ? `&resourcekey=${encodeURIComponent(resourceKey)}` : ""}`);
  for (const m of html.matchAll(/href=["']([^"']*(?:drive\.google\.com\/uc|drive\.usercontent\.google\.com\/download)[^"']*)["']/gi)) {
    add(new URL(decodeHtmlUrl(m[1]), "https://drive.google.com").toString());
  }
  const downloadUrl = /downloadUrl["']?\s*:\s*["']([^"']+)/i.exec(html)?.[1];
  if (downloadUrl) add(decodeHtmlUrl(downloadUrl));
  return [...out];
}
async function openDrivePublic(fileId, resourceKey) {
  const jar = new Map();
  let url = drivePublicUrl(fileId, resourceKey);
  const tried = new Set();
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetchWithCookies(url, jar);
    const ct = res.headers.get("content-type") || "";
    if (res.ok && !isHtmlContentType(ct)) {
      const cl = Number(res.headers.get("content-length") || res.headers.get("x-goog-stored-content-length") || FILE_SIZE || 0);
      const cd = res.headers.get("content-disposition");
      let fname = FILE_NAME;
      if (cd) {
        const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd);
        if (m) fname = decodeURIComponent(m[1]);
      }
      return { stream: await assertBinaryResponse(res, "Drive público"), contentLength: cl, contentType: ct || "application/octet-stream", fileName: fname };
    }
    const html = await res.text();
    const next = driveCandidates(html, fileId, resourceKey).find((u) => !tried.has(u));
    if (!next) throw new Error("Drive devolveu HTML sem link de confirmação (arquivo provavelmente não é público ou excedeu quota)");
    tried.add(next);
    url = next;
  }
  throw new Error("Drive público continuou retornando HTML em vez do arquivo");
}

async function openHttp(url) {
  const pdId = extractPixeldrainFileId(url);
  const fetchUrl = pdId ? `${PIXELDRAIN_BASE}/api/file/${pdId}` : url;
  const auth = Buffer.from(`:${PIXELDRAIN_API_KEY}`).toString("base64");
  let pdInfo = null;
  if (pdId) {
    const infoRes = await fetch(`${PIXELDRAIN_BASE}/api/file/${pdId}/info`, { headers: { Authorization: `Basic ${auth}` } });
    if (infoRes.ok) pdInfo = await infoRes.json().catch(() => null);
  }
  const res = await fetch(fetchUrl, {
    redirect: "follow",
    headers: { ...browserHeaders({ Accept: "*/*" }), ...(pdId ? { Authorization: `Basic ${auth}` } : {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "application/octet-stream";
  if (isHtmlContentType(ct)) {
    try { await res.body?.cancel?.(); } catch {}
    throw new Error("URL devolveu HTML (login/aviso)");
  }
  return {
    stream: await assertBinaryResponse(res, pdId ? "Pixeldrain" : "download"),
    contentLength: Number(pdInfo?.size || res.headers.get("content-length") || FILE_SIZE || 0),
    contentType: pdInfo?.mime_type || ct,
    fileName: pdInfo?.name || FILE_NAME,
  };
}

async function openSource() {
  const drive = extractDriveInfo(SOURCE_URL);
  if (drive) return await openDrivePublic(drive.fileId, drive.resourceKey);
  return await openHttp(SOURCE_URL);
}

async function uploadToPixeldrain(filePath, fileName, contentType) {
  const size = statSync(filePath).size;
  const auth = Buffer.from(`:${PIXELDRAIN_API_KEY}`).toString("base64");
  const url = `${PIXELDRAIN_BASE}/api/file/${encodeURIComponent(fileName)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": contentType,
      "Content-Length": String(size),
    },
    body: createReadStream(filePath),
    duplex: "half",
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Pixeldrain HTTP ${res.status}: ${txt.slice(0, 200)}`);
  let body;
  try { body = JSON.parse(txt); } catch { throw new Error(`Pixeldrain resp inválida: ${txt.slice(0, 100)}`); }
  if (!body.id) throw new Error(`Pixeldrain sem id: ${txt.slice(0, 100)}`);
  return { fileId: body.id, fileSize: size };
}

async function main() {
  console.log(`mirror ${MIRROR_ID} :: ${FILE_NAME}`);
  console.log(`source: ${SOURCE_URL}`);
  const tmpPath = join(tmpdir(), `mirror-${randomUUID()}.bin`);
  try {
    const src = await openSource();
    console.log(`download iniciado (${src.contentLength} bytes, ${src.contentType})`);
    const t0 = Date.now();
    await pipeline(src.stream, createWriteStream(tmpPath));
    const dlSec = ((Date.now() - t0) / 1000).toFixed(1);
    const sizeOnDisk = statSync(tmpPath).size;
    console.log(`download ok em ${dlSec}s (${sizeOnDisk} bytes)`);

    console.log("upload pro Pixeldrain…");
    const t1 = Date.now();
    const { fileId, fileSize } = await uploadToPixeldrain(tmpPath, src.fileName, src.contentType);
    const upSec = ((Date.now() - t1) / 1000).toFixed(1);
    console.log(`upload ok em ${upSec}s — file_id=${fileId}`);

    await callback({
      mirror_id: MIRROR_ID,
      status: "ready",
      pixeldrain_file_id: fileId,
      file_size: fileSize,
      mime_type: src.contentType,
    });
  } catch (err) {
    console.error("FALHA:", err.stack || err.message);
    await callback({
      mirror_id: MIRROR_ID,
      status: "error",
      error_message: (err && err.message) ? err.message : String(err),
    }).catch((e) => console.error("callback final falhou:", e.message));
    process.exit(1);
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

main();
