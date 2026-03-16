# PDF Merger App

A full-stack web application for uploading, arranging, and merging multiple PDF files into one — with a secure one-time download and automatic cloud file deletion.

The frontend runs from a **single HTML file** using React, Tailwind CSS, and SortableJS via CDN — no build step required. All file storage uses **Vercel Blob**, so the app runs cleanly on Vercel's serverless infrastructure with no local filesystem dependency.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Backend** | Node.js · Express · pdf-lib · multer (memory) · @vercel/blob |
| **Frontend** | React 18 CDN · Tailwind Play CDN · Babel Standalone · SortableJS |
| **Storage** | Vercel Blob (uploads + merged PDFs — deleted after download) |
| **Theme** | Silver / Gray / Black dark UI |
| **Runtime** | Node.js ≥ 18 |

---

## Features

- **PDF-only uploads** — validated on client (MIME + extension) and server (multer filter)
- **Drag-and-drop upload zone** — drop files directly or click to browse
- **Drag-to-reorder** — rearrange the merge sequence by dragging file rows
- **Session-based tracking** — each browser session manages its own uploaded files independently
- **One-time download token** — the merged PDF download link works exactly once
- **Secure auto-delete** — all Blobs (uploaded sources + merged result) are deleted from Vercel Blob immediately after the download stream completes
- **Stale cleanup job** — a background sweep removes abandoned Blobs older than 1 hour, running every 30 minutes
- **Vercel-compatible** — uses `multer.memoryStorage()` and Vercel Blob; no local file writes

---

## Quick Start

### Prerequisites

- Node.js ≥ 18
- A [Vercel Blob](https://vercel.com/docs/storage/vercel-blob) store linked to your project

### Local Development

```bash
# 1. Clone the repo
git clone https://github.com/nikhilbelwate/pdf-merger-app.git
cd pdf-merger-app

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Edit .env — add your BLOB_READ_WRITE_TOKEN from vercel.com/dashboard

# 4. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Deploy to Vercel

```bash
vercel deploy
```

Link a Blob store in the Vercel dashboard — `BLOB_READ_WRITE_TOKEN` is injected automatically.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BLOB_READ_WRITE_TOKEN` | **Yes** | Vercel Blob read/write token. Set automatically on Vercel; copy from dashboard for local dev. |
| `PORT` | No | HTTP port (default: `3000`) |

---

## How It Works

```
Browser
  │  1. Upload PDFs  →  XHR with progress events
  │  2. Drag rows to set merge order
  │  3. Click "Merge PDFs"
  ▼
Express Server
  │  • multer.memoryStorage() — files buffered in RAM, never written to disk
  │  • Each buffer uploaded to Vercel Blob  (uploads/<uuid>.pdf)
  │  • PDFs fetched from Blob, merged with pdf-lib
  │  • Merged PDF uploaded to Vercel Blob  (merged/<timestamp>.pdf)
  │  • One-time UUID token issued
  ▼
Browser
  │  4. Token received → auto-triggers download
  │
  ▼
Express /download/:token
  │  • Token invalidated immediately (one-time use)
  │  • Merged PDF fetched from Blob → sent to browser as buffer
  │  • On response finish: ALL Blobs deleted (sources + merged)
```

---

## Project Structure

```
pdf-merger-app/
├── server.js           — Express API: upload → Blob, merge, one-time download, cleanup
├── package.json        — Dependencies (includes @vercel/blob)
├── .env.example        — Environment variable template
├── public/
│   └── index.html      — Complete React frontend (CDN-based, zero build)
├── .gitignore
└── README.md
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/upload` | Multipart upload (`field: pdfs`). Pass `x-session-id` header to add to an existing session. Returns `{ sessionId, files[] }`. |
| `DELETE` | `/file/:sessionId/:fileId` | Remove a single file from the session; deletes its Blob. |
| `POST` | `/merge` | Body: `{ sessionId, fileOrder: string[] }`. Fetches Blobs, merges, uploads result. Returns `{ token, pageCount, sizeFormatted }`. |
| `GET` | `/download/:token` | **One-time use.** Fetches merged Blob, sends to client, then deletes all Blobs and invalidates the token. |

---

## Error Handling

| Scenario | HTTP Code | Behaviour |
|----------|-----------|-----------|
| Non-PDF file uploaded | 415 | Rejected before Blob upload; buffer discarded |
| File exceeds 100 MB | 413 | Rejected by multer before Blob upload |
| Blob upload fails (one file) | 502 | Already-uploaded Blobs in that batch are rolled back |
| Blob fetch fails during merge | 502 | Named file flagged in error message |
| Corrupt / encrypted PDF | 422 | Named file flagged; no Blob left orphaned |
| Blob fetch fails during download | 502 | All Blobs still cleaned up |
| Download token not found / used | 404 | Friendly HTML page with back link |

---

## Configuration

All limits are constants at the top of `server.js`:

| Constant | Default | Description |
|----------|---------|-------------|
| `MAX_FILE_SIZE` | 100 MB | Per-file upload limit |
| `MAX_FILE_COUNT` | 30 | Max PDFs per session |
| `STALE_THRESHOLD` | 1 hour | Age threshold for abandoned Blob cleanup |
| `CLEANUP_INTERVAL` | 30 min | How often the stale sweep runs |

---

## Frontend CDN Libraries

No install needed — loaded at runtime in `public/index.html`:

| Library | Version | Purpose |
|---------|---------|---------|
| React | 18.2.0 | UI framework |
| ReactDOM | 18.2.0 | DOM rendering |
| Babel Standalone | 7.23.5 | JSX → JS in browser |
| Tailwind CSS Play CDN | latest | Utility CSS |
| SortableJS | 1.15.2 | Drag-to-reorder |

---

## License

MIT
