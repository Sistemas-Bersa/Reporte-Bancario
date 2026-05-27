'use strict';

/**
 * Ruta Express para el extractor bancario.
 *
 * CÓMO INTEGRAR EN TU PROYECTO:
 *
 *   1. Copia la carpeta bank-extractor/ a tu proyecto (ej. src/services/bank-extractor/)
 *   2. Copia este archivo a src/routes/bankExtractor.js
 *   3. Ajusta el require de bank-extractor según donde lo coloques
 *   4. En tu app.js:
 *        const bankExtractorRoute = require('./routes/bankExtractor');
 *        app.use('/api/bank-extractor', bankExtractorRoute);
 *
 * ENDPOINTS:
 *   POST /api/bank-extractor/extract
 *     Body: multipart/form-data  { pdf: <archivo.pdf> }
 *     Response: archivo .xlsx como descarga
 *
 *   POST /api/bank-extractor/extract-json
 *     Body: multipart/form-data  { pdf: <archivo.pdf> }
 *     Response: { bank, count, transactions: [...] }
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const { detectBank, extractTransactions, exportToBuffer } = require('./index');

const router = express.Router();

// Multer: almacena temporalmente en /tmp
const upload = multer({
  dest: os.tmpdir(),
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.pdf') {
      return cb(new Error('Solo se permiten archivos PDF.'));
    }
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB máximo
});

// ─── POST /extract  →  descarga el .xlsx ─────────────────────────────────────
router.post('/extract', upload.single('pdf'), async (req, res) => {
  let namedPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió archivo PDF.' });
    }

    const originalName = req.file.originalname;
    const bank = detectBank(originalName);

    if (!bank) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: `No se pudo identificar el banco para: ${originalName}`,
        bancosSoportados: ['BBVA', 'SANTANDER', 'BANAMEX', 'BAJIO', 'BANORTE']
      });
    }

    // Renombrar el temp file al nombre original (necesario para la detección interna)
    namedPath = path.join(os.tmpdir(), `${Date.now()}_${originalName}`);
    fs.renameSync(req.file.path, namedPath);

    const transactions = await extractTransactions(namedPath);

    if (!transactions.length) {
      return res.status(422).json({
        error: 'No se encontraron transacciones en el PDF.',
        sugerencia: 'Verifica que el PDF no esté protegido con contraseña y que el formato sea el correcto.'
      });
    }

    const buffer   = await exportToBuffer(transactions);
    const baseName = path.basename(originalName, '.pdf');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`);
    res.send(buffer);

  } catch (err) {
    console.error('[BankExtractor] Error en /extract:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (namedPath && fs.existsSync(namedPath)) fs.unlinkSync(namedPath);
  }
});

// ─── POST /extract-json  →  devuelve JSON con las transacciones ───────────────
router.post('/extract-json', upload.single('pdf'), async (req, res) => {
  let namedPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió archivo PDF.' });
    }

    const originalName = req.file.originalname;
    const bank = detectBank(originalName);

    if (!bank) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        error: `No se pudo identificar el banco para: ${originalName}`,
        bancosSoportados: ['BBVA', 'SANTANDER', 'BANAMEX', 'BAJIO', 'BANORTE']
      });
    }

    namedPath = path.join(os.tmpdir(), `${Date.now()}_${originalName}`);
    fs.renameSync(req.file.path, namedPath);

    const transactions = await extractTransactions(namedPath);

    if (!transactions.length) {
      return res.status(422).json({ error: 'No se encontraron transacciones en el PDF.' });
    }

    res.json({ bank, count: transactions.length, transactions });

  } catch (err) {
    console.error('[BankExtractor] Error en /extract-json:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (namedPath && fs.existsSync(namedPath)) fs.unlinkSync(namedPath);
  }
});

module.exports = router;
