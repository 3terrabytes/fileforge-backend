const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS — allow your Netlify site and local dev
const allowedOrigins = [
  'https://oscarh.co.uk',
  'https://www.oscarh.co.uk',
  'https://fileforge.oscarh.co.uk',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  // Add your Netlify URL below once you have it:
  // 'https://your-site.netlify.app'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());
app.use(express.static(__dirname));

// Upload directory
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Multer storage
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB limit

// Cleanup old files every 30 mins
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    fs.readdirSync(dir).forEach(f => {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    });
  });
}, 30 * 60 * 1000);

// Health check
app.get('/', (req, res) => res.json({ status: 'FileForge backend running' }));

// ─── IMAGE CONVERSION ───────────────────────────────────────────────────────
app.post('/convert/image', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { format } = req.body;
  if (!format) return res.status(400).json({ error: 'No target format specified' });

  const inputPath = req.file.path;
  const outputName = uuidv4() + '.' + format.toLowerCase();
  const outputPath = path.join(OUTPUT_DIR, outputName);

  try {
    // Use ImageMagick (convert) for image conversion
    execSync(`convert "${inputPath}" "${outputPath}"`);
    res.download(outputPath, req.file.originalname.replace(/\.[^.]+$/, '') + '.' + format.toLowerCase(), () => {
      cleanup(inputPath, outputPath);
    });
  } catch (err) {
    cleanup(inputPath);
    res.status(500).json({ error: 'Image conversion failed', detail: err.message });
  }
});

// ─── PDF CONVERSION ──────────────────────────────────────────────────────────
app.post('/convert/pdf', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { format } = req.body;
  const inputPath = req.file.path;
  const baseName = uuidv4();
  const outputPath = path.join(OUTPUT_DIR, baseName + '.' + format.toLowerCase());

  try {
    if (format.toUpperCase() === 'PDF') {
      // Convert image/doc to PDF using LibreOffice
      execSync(`libreoffice --headless --convert-to pdf "${inputPath}" --outdir "${OUTPUT_DIR}"`);
      const libreOut = path.join(OUTPUT_DIR, path.basename(inputPath, path.extname(inputPath)) + '.pdf');
      fs.renameSync(libreOut, outputPath);
    } else if (['JPG','JPEG','PNG','WEBP'].includes(format.toUpperCase())) {
      // PDF to image using ImageMagick
      execSync(`convert -density 150 "${inputPath}[0]" -quality 92 "${outputPath}"`);
    } else if (format.toUpperCase() === 'TXT') {
      execSync(`pdftotext "${inputPath}" "${outputPath}"`);
    } else {
      // LibreOffice fallback
      execSync(`libreoffice --headless --convert-to ${format.toLowerCase()} "${inputPath}" --outdir "${OUTPUT_DIR}"`);
      const libreOut = path.join(OUTPUT_DIR, path.basename(inputPath, path.extname(inputPath)) + '.' + format.toLowerCase());
      fs.renameSync(libreOut, outputPath);
    }

    res.download(outputPath, req.file.originalname.replace(/\.[^.]+$/, '') + '.' + format.toLowerCase(), () => {
      cleanup(inputPath, outputPath);
    });
  } catch (err) {
    cleanup(inputPath);
    res.status(500).json({ error: 'PDF conversion failed', detail: err.message });
  }
});

// ─── DOCUMENT CONVERSION ─────────────────────────────────────────────────────
app.post('/convert/document', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { format } = req.body;
  const inputPath = req.file.path;
  const outputName = uuidv4() + '.' + format.toLowerCase();
  const outputPath = path.join(OUTPUT_DIR, outputName);

  try {
    execSync(`libreoffice --headless --convert-to ${format.toLowerCase()} "${inputPath}" --outdir "${OUTPUT_DIR}"`);
    const libreOut = path.join(OUTPUT_DIR, path.basename(inputPath, path.extname(inputPath)) + '.' + format.toLowerCase());
    if (fs.existsSync(libreOut)) fs.renameSync(libreOut, outputPath);

    res.download(outputPath, req.file.originalname.replace(/\.[^.]+$/, '') + '.' + format.toLowerCase(), () => {
      cleanup(inputPath, outputPath);
    });
  } catch (err) {
    cleanup(inputPath);
    res.status(500).json({ error: 'Document conversion failed', detail: err.message });
  }
});

// ─── VIDEO CONVERSION ─────────────────────────────────────────────────────────
app.post('/convert/video', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { format } = req.body;
  const inputPath = req.file.path;
  const outputName = uuidv4() + '.' + format.toLowerCase();
  const outputPath = path.join(OUTPUT_DIR, outputName);

  let ffmpegArgs = '';
  if (format.toUpperCase() === 'MP4') ffmpegArgs = '-c:v libx264 -c:a aac -movflags +faststart';
  else if (format.toUpperCase() === 'WEBM') ffmpegArgs = '-c:v libvpx-vp9 -c:a libopus';
  else if (format.toUpperCase() === 'GIF') ffmpegArgs = '-vf "fps=10,scale=480:-1:flags=lanczos" -loop 0';
  else if (format.toUpperCase() === 'AVI') ffmpegArgs = '-c:v mpeg4 -c:a mp3';
  else if (format.toUpperCase() === 'MOV') ffmpegArgs = '-c:v libx264 -c:a aac';

  const cmd = `ffmpeg -i "${inputPath}" ${ffmpegArgs} "${outputPath}" -y`;

  exec(cmd, (err) => {
    if (err) {
      cleanup(inputPath);
      return res.status(500).json({ error: 'Video conversion failed', detail: err.message });
    }
    res.download(outputPath, req.file.originalname.replace(/\.[^.]+$/, '') + '.' + format.toLowerCase(), () => {
      cleanup(inputPath, outputPath);
    });
  });
});

// ─── AUDIO CONVERSION ─────────────────────────────────────────────────────────
app.post('/convert/audio', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { format } = req.body;
  const inputPath = req.file.path;
  const outputName = uuidv4() + '.' + format.toLowerCase();
  const outputPath = path.join(OUTPUT_DIR, outputName);

  let ffmpegArgs = '';
  if (format.toUpperCase() === 'MP3') ffmpegArgs = '-c:a libmp3lame -q:a 2';
  else if (format.toUpperCase() === 'WAV') ffmpegArgs = '-c:a pcm_s16le';
  else if (format.toUpperCase() === 'OGG') ffmpegArgs = '-c:a libvorbis -q:a 4';
  else if (format.toUpperCase() === 'FLAC') ffmpegArgs = '-c:a flac';
  else if (format.toUpperCase() === 'AAC') ffmpegArgs = '-c:a aac -b:a 192k';
  else if (format.toUpperCase() === 'M4A') ffmpegArgs = '-c:a aac -b:a 192k';

  const cmd = `ffmpeg -i "${inputPath}" ${ffmpegArgs} "${outputPath}" -y`;

  exec(cmd, (err) => {
    if (err) {
      cleanup(inputPath);
      return res.status(500).json({ error: 'Audio conversion failed', detail: err.message });
    }
    res.download(outputPath, req.file.originalname.replace(/\.[^.]+$/, '') + '.' + format.toLowerCase(), () => {
      cleanup(inputPath, outputPath);
    });
  });
});

// ─── SPREADSHEET CONVERSION ───────────────────────────────────────────────────
app.post('/convert/spreadsheet', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { format } = req.body;
  const inputPath = req.file.path;
  const outputName = uuidv4() + '.' + format.toLowerCase();
  const outputPath = path.join(OUTPUT_DIR, outputName);

  try {
    execSync(`libreoffice --headless --convert-to ${format.toLowerCase()} "${inputPath}" --outdir "${OUTPUT_DIR}"`);
    const libreOut = path.join(OUTPUT_DIR, path.basename(inputPath, path.extname(inputPath)) + '.' + format.toLowerCase());
    if (fs.existsSync(libreOut)) fs.renameSync(libreOut, outputPath);

    res.download(outputPath, req.file.originalname.replace(/\.[^.]+$/, '') + '.' + format.toLowerCase(), () => {
      cleanup(inputPath, outputPath);
    });
  } catch (err) {
    cleanup(inputPath);
    res.status(500).json({ error: 'Spreadsheet conversion failed', detail: err.message });
  }
});

function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
}

app.listen(PORT, () => console.log(`FileForge backend running on port ${PORT}`));
