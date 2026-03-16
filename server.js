/**
 * PDF Merger Application — Server
 * ---------------------------------
 * Vercel-compatible Express server. All file I/O goes through
 * @vercel/blob — no local filesystem writes are required.
 *
 * Flow:
 *  1. POST /upload   → multer (memory) → Vercel Blob (uploads/)
 *  2. POST /merge    → fetch each blob → pdf-lib merge → Vercel Blob (merged/)
 *  3. GET  /download → fetch merged blob → stream to client → delete all blobs
 *  4. DELETE /file   → remove single blob from session
 *
 * Environment variables required:
 *  BLOB_READ_WRITE_TOKEN  — Vercel Blob token (auto-set on Vercel, add to .env locally)
 *  PORT                   — optional, defaults to 3000
 */

'use strict';

const express             = require('express');
const multer              = require('multer');
const { PDFDocument }     = require('pdf-lib');
const { put, del }        = require('@vercel/blob');
const path                = require('path');
const { v4: uuidv4 }      = require('uuid');

// ─── Startup guard ────────────────────────────────────────────────────────────

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.warn(
    '\n  ⚠️  BLOB_READ_WRITE_TOKEN is not set.' +
    '\n     Add it to your .env file for local development.' +
    '\n     On Vercel it is set automatically when Blob storage is linked.\n'
  );
}

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT             = process.env.PORT || 3000;
const MAX_FILE_SIZE    = 100 * 1024 * 1024;   // 100 MB per file
const MAX_FILE_COUNT   = 30;                   // max PDFs per session
const STALE_THRESHOLD  = 60 * 60 * 1000;      // 1 hour
const CLEANUP_INTERVAL = 30 * 60 * 1000;      // every 30 minutes

// ─── In-memory session stores ─────────────────────────────────────────────────

/**
 * sessionId → {
 *   files:     Array<{ id, originalName, blobUrl, size }>,
 *   createdAt: number
 * }
 */
const sessionStore = new Map();

/**
 * token → {
 *   mergedBlobUrl:    string,
 *   uploadedBlobUrls: string[],
 *   createdAt:        number
 * }
 */
const downloadTokens = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Silently delete a Vercel Blob URL.
 * Swallows "not found" errors so cleanup never crashes the process.
 */
async function safeDel(blobUrl) {
  if (!blobUrl) return;
  try {
    await del(blobUrl);
  } catch (err) {
    // BlobNotFound is expected when a file was already cleaned up
    if (!err.message?.includes('not found') && !err.message?.includes('Not Found')) {
      console.error(`[cleanup] Failed to delete blob ${blobUrl}:`, err.message);
    }
  }
}

/**
 * Delete an array of Blob URLs in parallel, swallowing all errors.
 */
async function safeDelMany(urls = []) {
  if (!urls.length) return;
  await Promise.allSettled(urls.map(safeDel));
}

// ─── Multer — memory storage (no local disk writes) ───────────────────────────

/**
 * Reject anything that is not a PDF at the MIME + extension level.
 */
function pdfOnlyFilter(_req, file, cb) {
  const allowedMimes = ['application/pdf', 'application/x-pdf'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedMimes.includes(file.mimetype) && ext === '.pdf') {
    cb(null, true);
  } else {
    cb(
      Object.assign(
        new Error(`"${file.originalname}" is not a PDF. Only .pdf files are accepted.`),
        { code: 'INVALID_FILE_TYPE' }
      ),
      false
    );
  }
}

const upload = multer({
  storage:    multer.memoryStorage(),   // ← files stay in RAM, never touch disk
  fileFilter: pdfOnlyFilter,
  limits:     { fileSize: MAX_FILE_SIZE, files: MAX_FILE_COUNT },
});

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ───────────────────────────────────────────────────────────────────

// ── POST /upload ──────────────────────────────────────────────────────────────
/**
 * Accepts multipart/form-data with field "pdfs" (one or many files).
 * Optional header: x-session-id — reuse an existing session to add more files.
 *
 * Steps:
 *  1. multer validates size / type / count limits in memory
 *  2. Each validated buffer is uploaded to Vercel Blob (uploads/ prefix)
 *  3. Blob URLs are stored in the session map
 */
app.post('/upload', (req, res) => {
  const uploader = upload.array('pdfs', MAX_FILE_COUNT);

  uploader(req, res, async (multerErr) => {
    // ── multer error handling ──────────────────────────────────────────────
    if (multerErr) {
      if (multerErr.code === 'INVALID_FILE_TYPE') {
        return res.status(415).json({ success: false, error: multerErr.message });
      }
      if (multerErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          error: `File exceeds the ${formatBytes(MAX_FILE_SIZE)} limit.`,
        });
      }
      if (multerErr.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({
          success: false,
          error: `Too many files. Maximum ${MAX_FILE_COUNT} PDFs per session.`,
        });
      }
      console.error('[upload] multer error:', multerErr);
      return res.status(500).json({ success: false, error: 'Upload processing failed: ' + multerErr.message });
    }

    if (!req.files?.length) {
      return res.status(400).json({ success: false, error: 'No files received.' });
    }

    // ── Upload each buffer to Vercel Blob ──────────────────────────────────
    const sessionId = req.headers['x-session-id'] || uuidv4();
    if (!sessionStore.has(sessionId)) {
      sessionStore.set(sessionId, { files: [], createdAt: Date.now() });
    }

    const uploadedBlobs = [];   // track for rollback on partial failure

    try {
      const incoming = await Promise.all(
        req.files.map(async (file) => {
          const blobPath = `uploads/${uuidv4()}_${Date.now()}.pdf`;

          let blobResult;
          try {
            blobResult = await put(blobPath, file.buffer, {
              access:      'public',
              contentType: 'application/pdf',
              addRandomSuffix: false,
            });
          } catch (blobErr) {
            throw Object.assign(
              new Error(`Failed to store "${file.originalname}" in Blob storage: ${blobErr.message}`),
              { code: 'BLOB_UPLOAD_ERROR', originalError: blobErr }
            );
          }

          uploadedBlobs.push(blobResult.url);

          return {
            id:           uuidv4(),
            originalName: file.originalname,
            blobUrl:      blobResult.url,
            size:         file.size,
          };
        })
      );

      sessionStore.get(sessionId).files.push(...incoming);

      return res.json({
        success: true,
        sessionId,
        files: incoming.map(f => ({
          id:            f.id,
          name:          f.originalName,
          size:          f.size,
          sizeFormatted: formatBytes(f.size),
        })),
      });

    } catch (err) {
      // Rollback: delete any blobs already uploaded in this batch
      console.error('[upload] Blob upload error:', err.message);
      await safeDelMany(uploadedBlobs);

      if (err.code === 'BLOB_UPLOAD_ERROR') {
        return res.status(502).json({ success: false, error: err.message });
      }
      return res.status(500).json({ success: false, error: 'Upload failed: ' + err.message });
    }
  });
});

// ── DELETE /file/:sessionId/:fileId ───────────────────────────────────────────
/**
 * Remove a single file from the session and delete its Blob.
 */
app.delete('/file/:sessionId/:fileId', async (req, res) => {
  const { sessionId, fileId } = req.params;
  const session = sessionStore.get(sessionId);

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found.' });
  }

  const idx = session.files.findIndex(f => f.id === fileId);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'File not found in session.' });
  }

  const [removed] = session.files.splice(idx, 1);

  // Fire-and-forget Blob deletion — don't let this block the response
  safeDel(removed.blobUrl).catch(() => {});

  return res.json({ success: true });
});

// ── POST /merge ───────────────────────────────────────────────────────────────
/**
 * Body: { sessionId: string, fileOrder: string[] }
 *
 * Steps:
 *  1. Fetch each PDF buffer from its Blob URL
 *  2. Merge using pdf-lib in the requested order
 *  3. Upload merged PDF to Vercel Blob (merged/ prefix)
 *  4. Issue a one-time download token
 *  5. Release the session entry (blob URLs tracked in the token)
 */
app.post('/merge', async (req, res) => {
  const { sessionId, fileOrder } = req.body;

  if (!sessionId || !Array.isArray(fileOrder) || fileOrder.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'sessionId and a non-empty fileOrder array are required.',
    });
  }

  const session = sessionStore.get(sessionId);
  if (!session?.files?.length) {
    return res.status(400).json({ success: false, error: 'No uploaded files found for this session.' });
  }

  const orderedFiles = fileOrder
    .map(id => session.files.find(f => f.id === id))
    .filter(Boolean);

  if (orderedFiles.length < 2) {
    return res.status(400).json({ success: false, error: 'At least 2 files are required to merge.' });
  }

  try {
    const mergedPdf = await PDFDocument.create();

    // ── Fetch and merge each PDF ─────────────────────────────────────────
    for (const fileInfo of orderedFiles) {
      let pdfBytes;
      try {
        const response = await fetch(fileInfo.blobUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        pdfBytes = await response.arrayBuffer();
      } catch (fetchErr) {
        return res.status(502).json({
          success: false,
          error: `Could not retrieve "${fileInfo.originalName}" from storage: ${fetchErr.message}`,
        });
      }

      let srcPdf;
      try {
        srcPdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
      } catch (parseErr) {
        return res.status(422).json({
          success: false,
          error: `"${fileInfo.originalName}" could not be parsed — it may be encrypted or corrupt.`,
        });
      }

      const copiedPages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
      copiedPages.forEach(p => mergedPdf.addPage(p));
    }

    // ── Set metadata ─────────────────────────────────────────────────────
    mergedPdf.setTitle('Merged Document');
    mergedPdf.setCreator('PDF Merger App');
    mergedPdf.setCreationDate(new Date());

    const mergedBytes = await mergedPdf.save();

    // ── Upload merged PDF to Blob ─────────────────────────────────────────
    let mergedBlobUrl;
    try {
      const mergedBlob = await put(
        `merged/merged_${Date.now()}.pdf`,
        Buffer.from(mergedBytes),
        { access: 'public', contentType: 'application/pdf', addRandomSuffix: false }
      );
      mergedBlobUrl = mergedBlob.url;
    } catch (blobErr) {
      console.error('[merge] Failed to upload merged PDF to Blob:', blobErr);
      return res.status(502).json({
        success: false,
        error: 'Failed to save the merged PDF to storage: ' + blobErr.message,
      });
    }

    // ── Issue one-time download token ─────────────────────────────────────
    const token = uuidv4();
    downloadTokens.set(token, {
      mergedBlobUrl,
      uploadedBlobUrls: session.files.map(f => f.blobUrl),
      createdAt: Date.now(),
    });

    // Release the session now that URLs are tracked in the token
    sessionStore.delete(sessionId);

    return res.json({
      success:       true,
      token,
      pageCount:     mergedPdf.getPageCount(),
      sizeFormatted: formatBytes(mergedBytes.length),
    });

  } catch (err) {
    console.error('[merge] Unexpected error:', err);
    return res.status(500).json({ success: false, error: 'Merge failed: ' + err.message });
  }
});

// ── GET /download/:token ──────────────────────────────────────────────────────
/**
 * One-time download endpoint.
 * Fetches the merged PDF from Blob, sends it to the client,
 * then deletes the merged blob AND all uploaded source blobs.
 */
app.get('/download/:token', async (req, res) => {
  const { token } = req.params;
  const data = downloadTokens.get(token);

  if (!data) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#09090b;color:#a1a1aa">
        <h2 style="color:#f4f4f5">Download link expired or already used.</h2>
        <p>Each merged PDF can only be downloaded once. Please go back and merge again.</p>
        <a href="/" style="color:#c0c0c0">← Back to PDF Merger</a>
      </body></html>
    `);
  }

  // Invalidate immediately — one-time use only
  downloadTokens.delete(token);

  const { mergedBlobUrl, uploadedBlobUrls } = data;

  // ── Fetch the merged PDF from Blob ────────────────────────────────────
  let pdfBuffer;
  try {
    const blobResponse = await fetch(mergedBlobUrl);
    if (!blobResponse.ok) {
      throw new Error(`Blob responded with HTTP ${blobResponse.status} ${blobResponse.statusText}`);
    }
    pdfBuffer = Buffer.from(await blobResponse.arrayBuffer());
  } catch (fetchErr) {
    console.error('[download] Failed to fetch merged blob:', fetchErr.message);
    // Best-effort cleanup even on fetch failure
    await safeDelMany([mergedBlobUrl, ...uploadedBlobUrls]);
    return res.status(502).send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#09090b;color:#a1a1aa">
        <h2 style="color:#f4f4f5">Could not retrieve the merged PDF.</h2>
        <p>${fetchErr.message}</p>
        <a href="/" style="color:#c0c0c0">← Back to PDF Merger</a>
      </body></html>
    `);
  }

  // ── Send PDF to client ────────────────────────────────────────────────
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="merged.pdf"');
  res.setHeader('Content-Length', pdfBuffer.length);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  res.send(pdfBuffer);

  // ── Delete all blobs after response is sent ───────────────────────────
  res.on('finish', async () => {
    await safeDelMany([mergedBlobUrl, ...uploadedBlobUrls]);
    console.log(`[download] Cleaned up ${1 + uploadedBlobUrls.length} blob(s) after download.`);
  });
});

// ─── Periodic stale-session / stale-token cleanup ─────────────────────────────

async function cleanupStale() {
  const now = Date.now();
  const staleUrls = [];

  // Expired download tokens
  for (const [token, data] of downloadTokens.entries()) {
    if (now - data.createdAt > STALE_THRESHOLD) {
      downloadTokens.delete(token);
      staleUrls.push(data.mergedBlobUrl, ...data.uploadedBlobUrls);
    }
  }

  // Abandoned sessions
  for (const [sid, session] of sessionStore.entries()) {
    if (now - session.createdAt > STALE_THRESHOLD) {
      sessionStore.delete(sid);
      session.files.forEach(f => staleUrls.push(f.blobUrl));
    }
  }

  if (staleUrls.length) {
    console.log(`[cleanup] Removing ${staleUrls.length} stale blob(s)…`);
    await safeDelMany(staleUrls);
  }
}

setInterval(() => {
  cleanupStale().catch(err => console.error('[cleanup] Error during stale sweep:', err.message));
}, CLEANUP_INTERVAL);

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  ✅  PDF Merger is running → http://localhost:${PORT}\n`);
});
