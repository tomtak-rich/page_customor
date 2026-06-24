const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DB_PATH = path.join(DATA_DIR, "photos.sqlite");
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    site_name TEXT NOT NULL,
    address TEXT DEFAULT '',
    memo TEXT DEFAULT '',
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    url TEXT NOT NULL,
    mime TEXT DEFAULT '',
    size INTEGER NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    confirmed_at TEXT
  );
`);

const insertPhoto = db.prepare(`
  INSERT INTO photos
    (company, site_name, address, memo, original_name, stored_name, url, mime, size)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const listPhotos = db.prepare(`
  SELECT * FROM photos
  ORDER BY confirmed ASC, datetime(created_at) DESC, id DESC
`);
const confirmPhoto = db.prepare(`
  UPDATE photos
  SET confirmed = ?, confirmed_at = CASE WHEN ? = 1 THEN datetime('now', 'localtime') ELSE NULL END
  WHERE id = ?
`);

/* ===== 고객/현장(sites) ===== */
db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '사장님',
    phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    partner TEXT DEFAULT '',
    amount INTEGER,
    memo TEXT DEFAULT '',
    category TEXT NOT NULL DEFAULT 'estimate',
    steps TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT
  );
`);

const insertSite = db.prepare(`
  INSERT INTO sites
    (id, name, title, phone, address, partner, amount, memo, category, steps)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const listSites = db.prepare(`SELECT * FROM sites ORDER BY datetime(created_at) DESC, rowid DESC`);
const getSite = db.prepare(`SELECT * FROM sites WHERE id = ?`);
const updateSite = db.prepare(`
  UPDATE sites
  SET name = ?, title = ?, phone = ?, address = ?, partner = ?,
      amount = ?, memo = ?, category = ?, steps = ?, updated_at = datetime('now', 'localtime')
  WHERE id = ?
`);
const deleteSite = db.prepare(`DELETE FROM sites WHERE id = ?`);

const CATEGORIES = ["estimate", "bidding", "construction", "done", "closure"];

function blankSteps() {
  return Array.from({ length: 10 }, () => ({ sent: false, at: null, resp: null }));
}

function seedSites() {
  function mk(name, title, phone, addr, partner, amount, memo, category, upto, resp4, resp8) {
    const s = blankSteps();
    for (let i = 0; i < upto; i++) { s[i].sent = true; s[i].at = (i + 1) + ".15 1" + i + ":00"; }
    if (resp4 && s[3].sent) s[3].resp = resp4;
    if (resp8 && s[7].sent) s[7].resp = resp8;
    return { name, title, phone, address: addr, partner, amount, memo, category, steps: s };
  }
  return [
    mk("정견적", "사장님", "010-7777-8888", "서울 송파구 ○○로 5", "", 1200000, "신규 견적 문의", "estimate", 1, null, null),
    mk("이본사", "고객님", "010-2222-3333", "경기 성남시 분당구 ○○로 8", "파트너A", 1800000, "주방 철거 + 폐기물", "bidding", 4, null, null),
    mk("김정석", "사장님", "010-1234-5678", "서울 강남구 테헤란로 12", "정석건설", 3500000, "상가 내부 철거", "construction", 6, "방문완료", null),
    mk("최대기", "사장님", "010-5555-6666", "서울 마포구 ○○길 3", "파트너B", 2400000, "", "construction", 8, "방문완료", null),
    mk("박완료", "사장님", "010-9876-5432", "인천 연수구 ○○대로 100", "정석건설", 5200000, "사무실 전체 철거", "done", 10, "방문완료", "공사완료")
  ];
}

function rowToSite(row) {
  let steps;
  try { steps = JSON.parse(row.steps); } catch (e) { steps = blankSteps(); }
  if (!Array.isArray(steps) || steps.length !== 10) steps = blankSteps();
  return {
    id: row.id, name: row.name, title: row.title, phone: row.phone,
    address: row.address, partner: row.partner, amount: row.amount,
    memo: row.memo, category: row.category, steps,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function normalizeSite(input) {
  const category = CATEGORIES.includes(input.category) ? input.category : "estimate";
  let steps = input.steps;
  if (!Array.isArray(steps) || steps.length !== 10) steps = blankSteps();
  return {
    name: String(input.name || "").trim(),
    title: String(input.title || "사장님").trim() || "사장님",
    phone: String(input.phone || "").trim(),
    address: String(input.address || "").trim(),
    partner: String(input.partner || "").trim(),
    amount: input.amount === null || input.amount === undefined || input.amount === "" ? null : Number(input.amount),
    memo: String(input.memo || "").trim(),
    category,
    steps: JSON.stringify(steps)
  };
}

// 최초 실행 시 비어 있으면 샘플 데이터로 채움
if (listSites.all().length === 0) {
  for (const site of seedSites()) {
    const s = normalizeSite(site);
    insertSite.run(crypto.randomUUID(), s.name, s.title, s.phone, s.address, s.partner, s.amount, s.memo, s.category, s.steps);
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function json(res, status, body) {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function serveFile(res, filePath) {
  if (!filePath.startsWith(ROOT)) return send(res, 403, "Forbidden");
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Not found");
    const type = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error("업로드 용량은 한 번에 50MB까지 가능합니다."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sanitizeFilename(name) {
  const base = path.basename(name || "photo").replace(/[^\w.\-가-힣]/g, "_");
  return base || "photo";
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);
  while (index !== -1) {
    parts.push(buffer.subarray(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }
  parts.push(buffer.subarray(start));
  return parts;
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!boundaryMatch) throw new Error("multipart boundary가 없습니다.");

  const boundary = Buffer.from("--" + (boundaryMatch[1] || boundaryMatch[2]));
  const fields = {};
  const files = [];

  for (const rawPart of splitBuffer(buffer, boundary)) {
    let part = rawPart;
    if (part.length === 0) continue;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(0, 2).toString() === "--") continue;

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;
    const headers = part.subarray(0, headerEnd).toString("utf8");
    let content = part.subarray(headerEnd + 4);
    if (content.subarray(content.length - 2).toString() === "\r\n") {
      content = content.subarray(0, content.length - 2);
    }

    const disposition = /content-disposition:\s*form-data;([^\r\n]+)/i.exec(headers);
    if (!disposition) continue;
    const nameMatch = /name="([^"]+)"/i.exec(disposition[1]);
    const filenameMatch = /filename="([^"]*)"/i.exec(disposition[1]);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    if (filenameMatch && filenameMatch[1]) {
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
      files.push({
        field: name,
        filename: sanitizeFilename(filenameMatch[1]),
        mime: typeMatch ? typeMatch[1].trim() : "application/octet-stream",
        data: content
      });
    } else {
      fields[name] = content.toString("utf8").trim();
    }
  }

  return { fields, files };
}

async function handleUpload(req, res) {
  const body = await readBody(req);
  const { fields, files } = parseMultipart(body, req.headers["content-type"]);
  const company = fields.company || "";
  const siteName = fields.site_name || "";

  if (!company || !siteName) {
    return json(res, 400, { error: "업체명과 현장명을 입력하세요." });
  }

  const imageFiles = files.filter((file) => file.field === "photos" && file.mime.startsWith("image/"));
  if (imageFiles.length === 0) {
    return json(res, 400, { error: "업로드할 사진을 선택하세요." });
  }

  const saved = [];
  for (const file of imageFiles) {
    const ext = path.extname(file.filename) || ".jpg";
    const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`;
    const fullPath = path.join(UPLOAD_DIR, storedName);
    fs.writeFileSync(fullPath, file.data);
    const url = `/uploads/${storedName}`;
    insertPhoto.run(
      company,
      siteName,
      fields.address || "",
      fields.memo || "",
      file.filename,
      storedName,
      url,
      file.mime,
      file.data.length
    );
    saved.push({ original_name: file.filename, url });
  }

  json(res, 201, { ok: true, count: saved.length, photos: saved });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
      return serveFile(res, path.join(ROOT, "index.html"));
    }
    if (req.method === "GET" && url.pathname === "/upload") {
      return serveFile(res, path.join(PUBLIC_DIR, "upload.html"));
    }
    if (req.method === "GET" && url.pathname === "/photos") {
      return serveFile(res, path.join(PUBLIC_DIR, "photos.html"));
    }
    if (req.method === "GET" && url.pathname === "/api/photos") {
      return json(res, 200, { photos: listPhotos.all() });
    }
    if (req.method === "POST" && url.pathname === "/api/photos") {
      return handleUpload(req, res);
    }
    const confirmMatch = /^\/api\/photos\/(\d+)\/confirm$/.exec(url.pathname);
    if (req.method === "PATCH" && confirmMatch) {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      confirmPhoto.run(body.confirmed ? 1 : 0, body.confirmed ? 1 : 0, Number(confirmMatch[1]));
      return json(res, 200, { ok: true });
    }

    // ===== 고객/현장 API =====
    if (req.method === "GET" && url.pathname === "/api/sites") {
      return json(res, 200, { sites: listSites.all().map(rowToSite) });
    }
    if (req.method === "POST" && url.pathname === "/api/sites") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!String(body.name || "").trim()) return json(res, 400, { error: "고객명을 입력하세요." });
      const s = normalizeSite(body);
      const id = crypto.randomUUID();
      insertSite.run(id, s.name, s.title, s.phone, s.address, s.partner, s.amount, s.memo, s.category, s.steps);
      return json(res, 201, { site: rowToSite(getSite.get(id)) });
    }
    const siteMatch = /^\/api\/sites\/([\w-]+)$/.exec(url.pathname);
    if (siteMatch) {
      const id = siteMatch[1];
      const existing = getSite.get(id);
      if (!existing) return json(res, 404, { error: "현장을 찾을 수 없습니다." });
      if (req.method === "PUT") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        if (!String(body.name || "").trim()) return json(res, 400, { error: "고객명을 입력하세요." });
        const s = normalizeSite(body);
        updateSite.run(s.name, s.title, s.phone, s.address, s.partner, s.amount, s.memo, s.category, s.steps, id);
        return json(res, 200, { site: rowToSite(getSite.get(id)) });
      }
      if (req.method === "DELETE") {
        deleteSite.run(id);
        return json(res, 200, { ok: true });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
      const file = path.normalize(path.join(UPLOAD_DIR, path.basename(url.pathname)));
      return serveFile(res, file);
    }
    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const file = path.normalize(path.join(ROOT, url.pathname));
      return serveFile(res, file);
    }

    send(res, 404, "Not found");
  } catch (err) {
    json(res, 500, { error: err.message || "서버 오류가 발생했습니다." });
  }
}

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`철거의정석 업로드 서버: http://localhost:${PORT}`);
  console.log(`업체 업로드: http://localhost:${PORT}/upload`);
  console.log(`관리자 사진함: http://localhost:${PORT}/photos`);
});
