# PDF Merger App

A full-stack web application for uploading, arranging, and merging multiple PDF files into one — with a secure one-time download and automatic server-side file deletion.

The frontend runs entirely from a **single HTML file** using React, Tailwind CSS, and SortableJS loaded from CDN — no build step or toolchain required.

---

## Tech Stack

| Layer    | Technology |
|----------|------------|
| **Backend** | Node.js · Express · pdf-lib · multer · uuid |
| **Frontend** | React 18 (CDN) · Tailwind CSS Play CDN · Babel Standalone · SortableJS |
| **Theme** | Silver / Gray / Black dark UI |
| **Runtime** | Node.js ≥ 16 — no separate frontend build needed |

---

## Features

- **PDF-only uploads** — validated on both client (MIME type + extension) and server
- **Drag-and-drop upload zone** — drop files directly or click to browse
- **Drag-to-reorder** — rearrange the merge sequence by dragging file rows
- **Session-based file tracking** — each browser session manages its own uploaded files independently
- **One-time download token** — the merged PDF download link works exactly once
- **Secure auto-delete** — all uploaded and merged files are deleted from the server immediately after the download stream completes
- **Stale file cleanup** — a background job removes any orphaned files older than 1 hour, running every 30 minutes
- **Responsive dark UI** — silver/gray/black theme, smooth animations, mobile-friendly layout

---

## Quick Start

### Prerequisites

- **Node.js ≥ 16** — that's it. No npm scripts for the frontend are needed.

### Install & Run

```bash
# Clone the repository
git clone https://github.com/nikhilbelwate/pdf-merger-app.git
cd pdf-merger-app

# Install server dependencies
npm install

# Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

For auto-restart on server file changes during development:

```bash
npm run dev
```

> The frontend (`public/index.html`) loads React, Tailwind, and SortableJS directly
> from CDN at runtime — there is no build step, no `npm run build`, and no separate
> dev server required.

---

## How It Works

```
Browser
  │  1. Upload PDFs (XHR with progress)
  │  2. Drag rows to set merge order
  │  3. Click "Merge PDFs"
  ▼
Express Server (port 3000)
  │  • Validates files (PDF only, max 100 MB each, up to 30 per session)
  │  • Stores uploads in uploads/ with UUID filenames
  │  • Merges using pdf-lib in the requested order
  │  • Issues a one-time UUID download token
  ▼
Browser
  │  4. Receives token → auto-triggers download
  │  5. Server streams merged PDF → deletes all files → token invalidated
  ▼
Server (cleanup)
  • All uploaded source files deleted
  • Merged file deleted
  • Download token removed
```

---

## Project Structure

```
pdf-merger-app/
├── server.js           — Express API: upload, merge, one-time download, cleanup
├── package.json        — Server-side dependencies
├── public/
│   └── index.html      — Complete React frontend (CDN-based, no build required)
├── uploads/            — Temporary upload storage  [auto-created · gitignored]
├── merged/             — Temporary merged PDF storage [auto-created · gitignored]
├── .gitignore
└── README.md
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/upload` | Upload one or more PDF files (`multipart/form-data`, field `pdfs`). Pass `x-session-id` header on subsequent calls to add to the same session. Returns `{ sessionId, files[] }`. |
| `DELETE` | `/file/:sessionId/:fileId` | Remove a single uploaded file from the session and disk. |
| `POST` | `/merge` | Body: `{ sessionId, fileOrder: string[] }`. Merges PDFs in the given ID order. Returns `{ token, pageCount, sizeFormatted }`. |
| `GET` | `/download/:token` | **One-time use.** Streams the merged PDF, then deletes all associated files and invalidates the token. |

---

## Configuration

All limits are defined as constants at the top of `server.js`:

| Constant | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port (override with `PORT` env var) |
| `MAX_FILE_SIZE` | `100 MB` | Maximum size per uploaded PDF |
| `MAX_FILE_COUNT` | `30` | Maximum PDFs per merge session |
| `STALE_THRESHOLD` | `1 hour` | Age at which orphaned files are removed |
| `CLEANUP_INTERVAL` | `30 min` | How often the stale-file sweep runs |

---

## Frontend CDN Dependencies

The `public/index.html` file loads these libraries at runtime — nothing to install:

| Library | Version | CDN Source |
|---------|---------|------------|
| React | 18.2.0 | cdnjs.cloudflare.com |
| ReactDOM | 18.2.0 | cdnjs.cloudflare.com |
| Babel Standalone | 7.23.5 | cdnjs.cloudflare.com |
| Tailwind CSS | Play CDN (latest) | cdn.tailwindcss.com |
| SortableJS | 1.15.2 | cdnjs.cloudflare.com |

---

## Security

- File type is validated at two layers: MIME type **and** `.pdf` extension check.
- All server-stored filenames are UUID v4 — original filenames never touch the filesystem.
- Download tokens are UUID v4 and invalidated on the first request.
- Files are deleted on both stream `end` and stream `error` events.
- Stale file cleanup prevents orphaned files accumulating if a session is abandoned.

---

## License

MIT
