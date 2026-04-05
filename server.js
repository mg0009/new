const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";
const DATA_FILE = path.join(__dirname, "logs.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TMP_DIR = path.join(__dirname, "tmp");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");

const upload = multer({ dest: TMP_DIR });

function getApiKey(req) {
  return req.headers["x-api-key"] || req.query.key || "";
}

function requireApiKey(req, res, next) {
  if (getApiKey(req) !== API_KEY) {
    return res.status(401).json({
      status: "unauthorized",
      message: "Invalid API key"
    });
  }
  next();
}

function readLogs() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeLogs(logs) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(logs, null, 2), "utf8");
}

function safeName(name) {
  return path.basename(name || "file.bin").replace(/[^\w.\-]/g, "_");
}

function formatSize(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = num;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getFileType(fileName, mime) {
  const ext = path.extname(fileName || "").toLowerCase();
  if ((mime || "").startsWith("image/") || [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) return "image";
  if ((mime || "").startsWith("video/") || [".mp4", ".webm", ".mov", ".mkv"].includes(ext)) return "video";
  if ((mime || "").startsWith("audio/") || [".mp3", ".wav", ".aac", ".m4a"].includes(ext)) return "audio";
  if ([".pdf", ".doc", ".docx", ".txt"].includes(ext)) return "document";
  if ([".zip", ".rar", ".7z"].includes(ext)) return "archive";
  return "file";
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function removeTempFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function buildGalleryData() {
  const logs = readLogs().sort((a, b) => new Date(b.time) - new Date(a.time));
  return logs.map((entry) => ({
    ...entry,
    url: `/files/${encodeURIComponent(entry.file)}`,
    type: getFileType(entry.original, entry.mime),
    sizeLabel: formatSize(entry.size)
  }));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderGalleryPage(files) {
  const cards = files
    .map((file) => {
      const preview =
        file.type === "image"
          ? `<img src="${file.url}?key=${encodeURIComponent(API_KEY)}" alt="${escapeHtml(file.original)}">`
          : `<div class="file-icon">${escapeHtml(file.type.toUpperCase())}</div>`;

      return `
        <article class="card">
          <div class="thumb">${preview}</div>
          <div class="meta">
            <h3>${escapeHtml(file.original)}</h3>
            <p>${escapeHtml(file.owner)}</p>
            <small>${escapeHtml(file.type)} • ${escapeHtml(file.sizeLabel)}</small>
            <small>${escapeHtml(new Date(file.time).toLocaleString("en-IN"))}</small>
          </div>
          <div class="actions">
            <a href="${file.url}?key=${encodeURIComponent(API_KEY)}" target="_blank" rel="noreferrer">Open</a>
            <a href="${file.url}?key=${encodeURIComponent(API_KEY)}" download>Download</a>
            <button type="button" onclick="deleteFile('${escapeHtml(file.file)}')">Delete</button>
          </div>
        </article>
      `;
    })
    .join("");

  return `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Secure Gallery</title>
      <style>
        body {
          margin: 0;
          font-family: "Segoe UI", sans-serif;
          background: #0b1110;
          color: #ecfff5;
        }
        .wrap {
          max-width: 1200px;
          margin: 0 auto;
          padding: 24px;
        }
        h1 {
          margin: 0 0 8px;
        }
        p.sub {
          color: #91aa9f;
          margin: 0 0 24px;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 16px;
        }
        .card {
          border: 1px solid rgba(109,255,177,0.16);
          border-radius: 18px;
          overflow: hidden;
          background: #101816;
        }
        .thumb {
          aspect-ratio: 4 / 3;
          background: #16211d;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .file-icon {
          padding: 16px;
          border: 1px solid rgba(109,255,177,0.16);
          border-radius: 12px;
          color: #6dffb1;
        }
        .meta {
          padding: 14px;
          display: grid;
          gap: 6px;
        }
        .meta h3 {
          margin: 0;
          font-size: 16px;
          word-break: break-word;
        }
        .meta p,
        .meta small {
          margin: 0;
          color: #91aa9f;
        }
        .actions {
          display: flex;
          gap: 12px;
          padding: 0 14px 14px;
          flex-wrap: wrap;
        }
        .actions a,
        .actions button {
          border: none;
          background: transparent;
          color: #6dffb1;
          text-decoration: none;
          cursor: pointer;
          font: inherit;
          padding: 0;
        }
        .actions button {
          color: #ff8b8b;
        }
      </style>
    </head>
    <body>
      <div class="wrap">
        <h1>Secure Gallery</h1>
        <p class="sub">${files.length} files stored</p>
        <div class="grid">
          ${cards || "<p>No files uploaded yet.</p>"}
        </div>
      </div>

      <script>
        async function deleteFile(file) {
          const ok = window.confirm("Delete " + file + "?");
          if (!ok) return;

          const res = await fetch("/delete-file?key=" + encodeURIComponent(${JSON.stringify(API_KEY)}), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file })
          });

          if (!res.ok) {
            window.alert("Delete failed");
            return;
          }

          window.location.reload();
        }
      </script>
    </body>
  </html>
  `;
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "secure-gallery-server",
    endpoints: {
      upload: "POST /upload",
      gallery_json: "GET /gallery",
      gallery_html: "GET /gallery-page",
      file: "GET /files/:name",
      delete: "POST /delete-file"
    }
  });
});

app.post("/upload", requireApiKey, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      status: "error",
      message: "Missing file"
    });
  }

  const owner = String(req.body.owner || "default");
  const original = safeName(req.file.originalname);
  const tempPath = req.file.path;

  try {
    const hash = await sha256File(tempPath);
    const logs = readLogs();

    const existing = logs.find(
      (item) =>
        item.owner === owner &&
        item.original === original &&
        item.hash === hash
    );

    if (existing) {
      removeTempFile(tempPath);
      return res.json({
        status: "duplicate",
        message: "File already exists",
        file: existing.file,
        owner,
        original
      });
    }

    const finalName = `${Date.now()}_${original}`;
    const finalPath = path.join(UPLOAD_DIR, finalName);

    fs.renameSync(tempPath, finalPath);

    const stat = fs.statSync(finalPath);

    const entry = {
      id: crypto.randomUUID(),
      owner,
      original,
      file: finalName,
      hash,
      size: stat.size,
      mime: req.file.mimetype || "application/octet-stream",
      time: new Date().toISOString()
    };

    logs.push(entry);
    writeLogs(logs);

    return res.json({
      status: "uploaded",
      entry
    });
  } catch {
    removeTempFile(tempPath);
    return res.status(500).json({
      status: "error",
      message: "Upload failed"
    });
  }
});

app.get("/gallery", requireApiKey, (_req, res) => {
  res.json({
    files: buildGalleryData()
  });
});

app.get("/gallery-page", requireApiKey, (_req, res) => {
  res.send(renderGalleryPage(buildGalleryData()));
});

app.get("/files/:name", requireApiKey, (req, res) => {
  const fileName = path.basename(req.params.name || "");
  if (!fileName) return res.status(400).end();

  const filePath = path.join(UPLOAD_DIR, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  res.sendFile(filePath);
});

app.post("/delete-file", requireApiKey, (req, res) => {
  const fileName = path.basename(req.body?.file || "");
  if (!fileName) {
    return res.status(400).json({
      status: "error",
      message: "Missing file"
    });
  }

  const filePath = path.join(UPLOAD_DIR, fileName);
  const logs = readLogs();
  const nextLogs = logs.filter((item) => item.file !== fileName);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    writeLogs(nextLogs);

    return res.json({
      status: "deleted",
      file: fileName
    });
  } catch {
    return res.status(500).json({
      status: "error",
      message: "Delete failed"
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
