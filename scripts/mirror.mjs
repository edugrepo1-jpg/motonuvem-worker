// Worker do GitHub Actions: baixa SOURCE_URL e sobe pra Pixeldrain,
// depois reporta resultado via CALLBACK_URL (HMAC simples por token).
// Roda em runner Ubuntu — sem dependências externas além do Node 20.

import { createWriteStream, createReadStream, statSync, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const {
  MIRROR_ID, SOURCE_URL, FILE_NAME, CALLBACK_URL,
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
function decodeHtmlUrl(v) { return v.replace(/&amp;/g, "&").replace(/&#34;/g, '"').replace(/&quot;/g, '"'); }
function browserHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
    ...extra,
  };
}

function extractDriveFileId(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("drive.google.com") && !u.hostname.includes("drive.usercontent.google.com")) return null;
    const m = /\/file\/d\/([^/?#]+)/.exec(u.pathname);
    return m?.[1] || u.searchParams.get("id") || null;
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

async function openDrivePublic(fileId) {
  const jar = new Map();
  let url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchWithCookies(url, jar);
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
      const cl = Number(res.headers.get("content-length") || 0);
      const cd = res.headers.get("content-disposition");
      let fname = FILE_NAME;
      if (cd) {
        const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd);
        if (m) fname = decodeURIComponent(m[1]);
      }
      return { stream: res.body, contentLength: cl, contentType: ct || "application/octet-stream", fileName: fname };
    }
    // html → procura link de confirmação
    const html = await res.text();
    const formMatch = /<form[^>]+id="download-form"[^>]+action="([^"]+)"/i.exec(html);
    if (formMatch) {
      const action = decodeHtmlUrl(formMatch[1]);
      const params = new URLSearchParams();
      const fieldRe = /<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi;
      let m;
      while ((m = fieldRe.exec(html))) params.set(m[1], decodeHtmlUrl(m[2]));
      url = `${action}?${params.toString()}`;
      continue;
    }
    const confirmMatch = /confirm=([0-9A-Za-z_]+)/.exec(html);
    if (confirmMatch) {
      url = `https://drive.google.com/uc?export=download&confirm=${confirmMatch[1]}&id=${fileId}`;
      continue;
    }
    throw new Error("Drive devolveu HTML sem link de confirmação (arquivo provavelmente não é público)");
  }
  throw new Error("Drive: muitas tentativas de confirmação");
}

async function openHttp(url) {
  const res = await fetch(url, { redirect: "follow", headers: browserHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "application/octet-stream";
  if (ct.includes("text/html")) {
    try { await res.body?.cancel?.(); } catch {}
    throw new Error("URL devolveu HTML (login/aviso)");
  }
  return {
    stream: res.body,
    contentLength: Number(res.headers.get("content-length") || 0),
    contentType: ct,
    fileName: FILE_NAME,
  };
}

async function openSource() {
  const driveId = extractDriveFileId(SOURCE_URL);
  if (driveId) return await openDrivePublic(driveId);
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
