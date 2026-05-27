'use strict';

const express  = require('express');
const multer   = require('multer');
const { ZipArchive } = require('archiver');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const { detectBank, extractTransactions, exportToBuffer } = require('../services/bank-extractor');

const router = express.Router();

const upload = multer({
  dest: os.tmpdir(),
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.pdf') {
      return cb(new Error('Solo se permiten archivos PDF.'));
    }
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── POST /extract  →  un solo PDF → descarga .xlsx ───────────────────────────
router.post('/extract', upload.single('pdf'), async (req, res) => {
  let namedPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo PDF.' });

    const bank = detectBank(req.file.originalname);
    if (!bank) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: `Banco no identificado: ${req.file.originalname}`,
        bancosSoportados: ['BBVA', 'SANTANDER', 'BANAMEX', 'BAJIO', 'BANORTE']
      });
    }

    namedPath = path.join(os.tmpdir(), `${Date.now()}_${req.file.originalname}`);
    fs.renameSync(req.file.path, namedPath);

    const transactions = await extractTransactions(namedPath);
    if (!transactions.length) {
      return res.status(422).json({ error: 'No se encontraron transacciones en el PDF.' });
    }

    const buffer   = await exportToBuffer(transactions);
    const baseName = path.basename(req.file.originalname, '.pdf');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`);
    res.send(buffer);

  } catch (err) {
    console.error('[/extract]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (namedPath && fs.existsSync(namedPath)) fs.unlinkSync(namedPath);
  }
});

// ── POST /extract-multiple  →  varios PDFs → descarga .zip con todos los .xlsx
router.post('/extract-multiple', upload.array('pdfs', 30), async (req, res) => {
  const tempPaths = [];
  try {
    if (!req.files?.length) {
      return res.status(400).json({ error: 'No se recibieron archivos PDF.' });
    }

    // Procesar cada PDF y recolectar resultados
    const results = [];
    for (const file of req.files) {
      const namedPath = path.join(os.tmpdir(), `${Date.now()}_${file.originalname}`);
      fs.renameSync(file.path, namedPath);
      tempPaths.push(namedPath);

      const bank = detectBank(file.originalname);
      if (!bank) {
        results.push({ name: file.originalname, error: 'Banco no identificado', buffer: null });
        continue;
      }

      try {
        const transactions = await extractTransactions(namedPath);
        if (!transactions.length) {
          results.push({ name: file.originalname, error: 'Sin transacciones', buffer: null });
        } else {
          const buffer = await exportToBuffer(transactions);
          const xlsxName = path.basename(file.originalname, '.pdf') + '.xlsx';
          results.push({ name: xlsxName, error: null, buffer, count: transactions.length });
        }
      } catch (e) {
        results.push({ name: file.originalname, error: e.message, buffer: null });
      }
    }

    // Si solo hay un archivo con éxito, devolver el xlsx directo
    const successful = results.filter(r => r.buffer);
    if (!successful.length) {
      return res.status(422).json({
        error: 'Ningún archivo generó transacciones.',
        detalles: results.map(r => ({ archivo: r.name, error: r.error }))
      });
    }

    if (successful.length === 1 && results.length === 1) {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${successful[0].name}"`);
      return res.send(successful[0].buffer);
    }

    // Múltiples archivos → ZIP
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="estados_de_cuenta.zip"');

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.pipe(res);

    for (const r of successful) {
      archive.append(r.buffer, { name: r.name });
    }

    // Si algunos fallaron, incluir un resumen
    const failed = results.filter(r => r.error);
    if (failed.length) {
      const summary = failed.map(r => `${r.name}: ${r.error}`).join('\n');
      archive.append(summary, { name: '_errores.txt' });
    }

    await archive.finalize();

  } catch (err) {
    console.error('[/extract-multiple]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  } finally {
    for (const p of tempPaths) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
});

// ── POST /preview  →  un PDF → JSON con transacciones (tabla React) ──────────
router.post('/preview', upload.single('pdf'), async (req, res) => {
  let namedPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo PDF.' });

    const bank = detectBank(req.file.originalname);
    if (!bank) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Banco no identificado: ${req.file.originalname}` });
    }

    namedPath = path.join(os.tmpdir(), `${Date.now()}_${req.file.originalname}`);
    fs.renameSync(req.file.path, namedPath);

    const transactions = await extractTransactions(namedPath);
    if (!transactions.length) {
      return res.status(422).json({ error: 'No se encontraron transacciones.' });
    }

    res.json({ bank, count: transactions.length, transactions });

  } catch (err) {
    console.error('[/preview]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (namedPath && fs.existsSync(namedPath)) fs.unlinkSync(namedPath);
  }
});

module.exports = router;
