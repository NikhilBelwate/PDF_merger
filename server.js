/**
 * PDF Merger Application - Server
 * --------------------------------
 * Microservice-style Express server that handles:
 *  - PDF-only file uploads (validated server-side)
 *  - Session-scoped file tracking
 *  - In-order PDF merging via pdf-lib
 *  - One-time tokenised downloads (files deleted after download)
 *  - Automatic cleanup of stale files every 30 minutes
 */

'use strict';

const express    = require('express');
const multer     = require('multer');
const { PDFDocument } = require('pdf-lib');
const fs         = require('fs');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT        = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MERGED_DIR  = path.join(__dirname, 'merged');
const MAX_FILE_SIZE   = 100 * 1024 * 1024;  // 100 MB per file
const MAX_FILE_COUNT  = 30;                  // max PDFs per merge session
const STALE_THRESHOLD = 60 * 60 * 1000;     // 1 hour
const CLEANUP_INTERVAL = 30 * 60 * 1000;    // every 30 minutes

// ─── Bootstrap directories ────────────────────────────────────────────────────

[UPLOADS_DIR, MERGED_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── In-memory stores ─────────────────────────────────────────────────────────

/** sessionId → Array<{ id, originalName, storedName, path, size }> */
const sessionFiles = new Map();

/** token → { mergedPath, uploadedFiles: string[], createdAt } */
const downloadTokens = new Map();

// ─── Multer setup (PDF-only) ──────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, _file, cb) => cb(null, `${uuidv4()}_${Date.now()}.pdf`),
});

/**
 * Double-layer validation:
 *  1. MIME type (browsers set this from the OS)
 *  2. File extension (extra safety net)
 */
function pdfOnlyFilter(req, file, cb) {
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
  storage,
  fileFilter: pdfOnlyFilter,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILE_COUNT },
});

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeUnlink(filePath) {
  fs.unlink(filePath, err => {
    if (err && err.code !== 'ENOENT') {
      console.error(`[cleanup] Failed to delete ${filePath}:`, err.message);
    }
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /upload
 * Accepts multipart/form-data with field "pdfs" (multiple files).
 * Header: x-session-id (optional; returned in response for subsequent calls)
 */
app.post('/upload', (req, res) => {
  const uploader = upload.array('pdfs', MAX_FILE_COUNT);

  uploader(req, res, err => {
    if (err) {
      if (err.code === 'INVALID_FILE_TYPE') {
        return res.status(415).json({ success: false, error: err.message });
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          error: `File too large. Maximum allowed size is ${formatBytes(MAX_FILE_SIZE)}.`,
        });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({
          success: false,
          error: `Too many files. Maximum ${MAX_FILE_COUNT} PDFs per session.`,
        });
      }
      return res.status(500).json({ success: false, error: err.message });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files were uploaded.' });
    }

    const sessionId = req.headers['x-session-id'] || uuidv4();
    if (!sessionFiles.has(sessionId)) sessionFiles.set(sessionId, []);

    const incoming = req.files.map(file => ({
      id:           uuidv4(),
      originalName: file.originalname,
      storedName:   file.filename,
      path:         file.path,
      size:         file.size,
    }));

    sessionFiles.get(sessionId).push(...incoming);

    return res.json({
      success: true,
      sessionId,
      files: incoming.map(f => ({
        id:   f.id,
        name: f.originalName,
        size: f.size,
        sizeFormatted: formatBytes(f.size),
      })),
    });
  });
});

/**
 * DELETE /file/:sessionId/:fileId
 * Removes a single uploaded file from the session and disk.
 */
app.delete('/file/:sessionId/:fileId', (req, res) => {
  const { sessionId, fileId } = req.params;
  const files = sessionFiles.get(sessionId);

  if (!files) {
    return res.status(404).json({ success: false, error: 'Session not found.' });
  }

  const idx = files.findIndex(f => f.id === fileId);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: 'File not found in session.' });
  }

  const [removed] = files.splice(idx, 1);
  safeUnlink(removed.path);

  return res.json({ success: true });
});

/**
 * POST /merge
 * Body: { sessionId: string, fileOrder: string[] }
 * fileOrder is an array of file IDs in the desired merge sequence.
 * Returns a one-time download token.
 */
app.post('/merge', async (req, res) => {
  const { sessionId, fileOrder } = req.body;

  if (!sessionId || !Array.isArray(fileOrder) || fileOrder.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'sessionId and a non-empty fileOrder array are required.',
    });
  }

  const files = sessionFiles.get(sessionId);
  if (!files || files.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No uploaded files found for this session.',
    });
  }

  // Resolve the ordered file list
  const orderedFiles = fileOrder
    .map(id => files.find(f => f.id === id))
    .filter(Boolean);

  if (orderedFiles.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'None of the provided file IDs match uploaded files.',
    });
  }

  try {
    const mergedPdf = await PDFDocument.create();

    for (const fileInfo of orderedFiles) {
      const bytes = fs.readFileSync(fileInfo.path);
      let srcPdf;
      try {
        srcPdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
      } catch {
        return res.status(422).json({
          success: false,
          error: `"${fileInfo.originalName}" could not be read. It may be encrypted or corrupt.`,
        });
      }
      const copiedPages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
      copiedPages.forEach(p => mergedPdf.addPage(p));
    }

    // Set merged PDF metadata
    mergedPdf.setTitle('Merged Document');
    mergedPdf.setCreator('PDF Merger App');
    mergedPdf.setCreationDate(new Date());

    const mergedBytes   = await mergedPdf.save();
    const mergedFileName = `merged_${Date.now()}.pdf`;
    const mergedPath    = path.join(MERGED_DIR, mergedFileName);
    fs.writeFileSync(mergedPath, mergedBytes);

    // Issue one-time download token
    const token = uuidv4();
    downloadTokens.set(token, {
      mergedPath,
      uploadedFiles: files.map(f => f.path),
      createdAt:     Date.now(),
    });

    // Release session (uploaded file paths tracked in the token)
    sessionFiles.delete(sessionId);

    return res.json({
      success: true,
      token,
      pageCount: mergedPdf.getPageCount(),
      sizeFormatted: formatBytes(mergedBytes.length),
    });
  } catch (err) {
    console.error('[merge] Error:', err);
    return res.status(500).json({ success: false, error: 'Merge failed: ' + err.message });
  }
});

/**
 * GET /download/:token
 * One-time download endpoint.
 * Streams the merged PDF then deletes ALL associated files.
 */
app.get('/download/:token', (req, res) => {
  const { token } = req.params;
  const data = downloadTokens.get(token);

  if (!data) {
    return res.status(404).send(
      '<h2>Download link has expired or was already used.</h2><p>Please go back and merge again.</p>'
    );
  }

  // Immediately invalidate the token (one-time use)
  downloadTokens.delete(token);

  const { mergedPath, uploadedFiles } = data;

  if (!fs.existsSync(mergedPath)) {
    return res.status(404).send('<h2>Merged file not found.</h2>');
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="merged.pdf"');
  res.setHeader('Cache-Control', 'no-store');

  const stream = fs.createReadStream(mergedPath);

  function cleanupAll() {
    safeUnlink(mergedPath);
    uploadedFiles.forEach(safeUnlink);
  }

  stream.on('end',   cleanupAll);
  stream.on('error', err => {
    console.error('[download] Stream error:', err.message);
    cleanupAll();
  });

  stream.pipe(res);
});

// ─── Periodic stale-file cleanup ──────────────────────────────────────────────

function cleanupStaleFiles() {
  const now = Date.now();

  // Remove expired download tokens + their files
  for (const [token, data] of downloadTokens.entries()) {
    if (now - data.createdAt > STALE_THRESHOLD) {
      downloadTokens.delete(token);
      safeUnlink(data.mergedPath);
      data.uploadedFiles.forEach(safeUnlink);
    }
  }

  // Remove orphaned disk files in uploads/ and merged/
  [UPLOADS_DIR, MERGED_DIR].forEach(dir => {
    fs.readdir(dir, (err, files) => {
      if (err) return;
      files.forEach(file => {
        const filePath = path.join(dir, file);
        fs.stat(filePath, (statErr, stat) => {
          if (!statErr && now - stat.mtimeMs > STALE_THRESHOLD) {
            safeUnlink(filePath);
          }
        });
      });
    });
  });
}

setInterval(cleanupStaleFiles, CLEANUP_INTERVAL);

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  ✅  PDF Merger is running → http://localhost:${PORT}\n`);
});
