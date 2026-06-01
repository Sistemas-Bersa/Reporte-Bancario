'use strict';

const { app } = require('@azure/functions');
const archiver = require('archiver');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const {
  detectBank,
  resolveBank,
  extractTransactions,
  extractTransactionsFromText,
  exportToBuffer
} = require('../../services/bank-extractor');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function saveUploadedFile(file) {
  const buffer   = Buffer.from(await file.arrayBuffer());
  const tempPath = path.join(os.tmpdir(), `${Date.now()}_${path.basename(file.name)}`);
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}

async function buildZip(entries) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks  = [];
  archive.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    archive.on('end',   resolve);
    archive.on('error', reject);
  });
  for (const { name, buffer } of entries) archive.append(buffer, { name });
  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

// ── GET /api/diagnose  — verifica cada dependencia paso a paso ────────────────
app.http('diagnose', {
  methods:   ['GET'],
  authLevel: 'anonymous',
  route:     'diagnose',
  handler:   async (_req, context) => {
    const report = {
      env:          process.env.FUNCTIONS_WORKER_RUNTIME || 'local',
      node:         process.version,
      tmpdir:       os.tmpdir(),
      tmpWritable:  false,
      canvasOk:     false,
      canvasError:  null,
      tesseractOk:  false,
      tesseractError: null,
      trainedDataPath: null,
      trainedDataExists: false,
      trainedDataSizeKB: 0,
      pdfjsOk:      false,
      pdfjsError:   null,
    };

    // 1. Escritura en /tmp
    try {
      const p = path.join(os.tmpdir(), `diag_${Date.now()}.txt`);
      fs.writeFileSync(p, 'ok');
      fs.unlinkSync(p);
      report.tmpWritable = true;
    } catch (e) { report.tmpWritable = false; }

    // 2. @napi-rs/canvas
    try {
      const { createCanvas } = require('@napi-rs/canvas');
      const c = createCanvas(10, 10);
      c.getContext('2d');
      report.canvasOk = true;
    } catch (e) { report.canvasError = e.message; }

    // 3. Tesseract + spa.traineddata
    const langPath = path.join(__dirname, '../../..');   // server/
    report.trainedDataPath   = path.join(langPath, 'spa.traineddata');
    report.trainedDataExists = fs.existsSync(report.trainedDataPath);
    if (report.trainedDataExists) {
      report.trainedDataSizeKB = Math.round(
        fs.statSync(report.trainedDataPath).size / 1024
      );
    }
    try {
      const Tesseract = require('tesseract.js');
      const w = await Tesseract.createWorker('spa', 1, {
        langPath,
        gzip:   false,
        logger: () => {}
      });
      await w.terminate();
      report.tesseractOk = true;
    } catch (e) { report.tesseractError = e.message; }

    // 4. pdfjs-dist
    try {
      require('pdfjs-dist/legacy/build/pdf.js');
      report.pdfjsOk = true;
    } catch (e) { report.pdfjsError = e.message; }

    context.log('DIAGNOSE:', JSON.stringify(report));
    return { status: 200, jsonBody: report };
  }
});

// ── POST /api/bank-extractor/extract-multiple ─────────────────────────────────
app.http('extractMultiple', {
  methods:   ['POST'],
  authLevel: 'anonymous',
  route:     'bank-extractor/extract-multiple',
  handler:   async (request, context) => {
    const tempPaths = [];
    const log       = (...args) => context.log('[extract-multiple]', ...args);
    const logErr    = (...args) => context.error('[extract-multiple]', ...args);

    try {
      log('Recibiendo formData…');
      const formData = await request.formData();
      const files    = formData.getAll('pdfs').filter(f => typeof f !== 'string');
      log(`Archivos recibidos: ${files.length}`);

      if (!files.length) {
        return { status: 400, jsonBody: { error: 'No se recibieron archivos PDF.' } };
      }

      const results = [];

      for (const file of files) {
        log(`Procesando: ${file.name} (${Math.round(file.size/1024)} KB)`);

        if (!file.name.toLowerCase().endsWith('.pdf')) {
          results.push({ name: file.name, error: 'No es un PDF', buffer: null });
          continue;
        }
        const bank = detectBank(file.name);
        if (!bank) {
          results.push({ name: file.name, error: 'Banco no identificado', buffer: null });
          continue;
        }
        log(`Banco detectado: ${bank}`);

        let tempPath = null;
        let step = 'init';
        try {
          step = 'save-temp';
          log('Guardando archivo temporal…');
          tempPath = await saveUploadedFile(file);
          tempPaths.push(tempPath);
          log(`Temp: ${tempPath}`);

          step = 'extract-transactions';
          log('Extrayendo transacciones…');
          const transactions = await extractTransactions(tempPath, context.log.bind(context));
          log(`Transacciones extraídas: ${transactions.length}`);

          if (!transactions.length) {
            results.push({ name: file.name, error: 'Sin transacciones', buffer: null });
          } else {
            step = 'export-to-buffer';
            log('Generando Excel…');
            const buffer   = await exportToBuffer(transactions);
            const xlsxName = path.basename(file.name, '.pdf') + '.xlsx';
            results.push({ name: xlsxName, error: null, buffer, count: transactions.length });
            log(`Excel listo: ${xlsxName}`);
          }
        } catch (e) {
          logErr(`Error en ${file.name} [step=${step}]:`, e.message, e.stack);
          results.push({ name: file.name, error: `[${step}] ${e.message}`, buffer: null });
        }
      }

      const successful = results.filter(r => r.buffer);
      log(`Exitosos: ${successful.length}/${results.length}`);

      if (!successful.length) {
        return {
          status: 422,
          jsonBody: {
            error:    'Ningún archivo generó transacciones.',
            detalles: results.map(r => ({ archivo: r.name, error: r.error }))
          }
        };
      }

      if (successful.length === 1 && results.length === 1) {
        log('Enviando xlsx directo…');
        return {
          status:  200,
          body:    successful[0].buffer,
          headers: {
            'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${successful[0].name}"`
          }
        };
      }

      log('Generando ZIP…');
      const zipEntries = successful.map(r => ({ name: r.name, buffer: r.buffer }));
      const failed     = results.filter(r => r.error);
      if (failed.length) {
        const summary = failed.map(r => `${r.name}: ${r.error}`).join('\n');
        zipEntries.push({ name: '_errores.txt', buffer: Buffer.from(summary) });
      }
      const zipBuffer = await buildZip(zipEntries);
      log('ZIP listo.');
      return {
        status:  200,
        body:    zipBuffer,
        headers: {
          'Content-Type':        'application/zip',
          'Content-Disposition': 'attachment; filename="estados_de_cuenta.zip"'
        }
      };

    } catch (err) {
      logErr('ERROR CRÍTICO:', err.message, '\nStack:', err.stack);
      return {
        status:   500,
        jsonBody: {
          error: err.message || 'Error interno desconocido',
          stack: err.stack   || '(sin stack)',
          step:  'extract-multiple-outer-catch'
        }
      };
    } finally {
      for (const p of tempPaths) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
  }
});

// ── POST /api/bank-extractor/extract ─────────────────────────────────────────
app.http('extract', {
  methods:   ['POST'],
  authLevel: 'anonymous',
  route:     'bank-extractor/extract',
  handler:   async (request, context) => {
    let tempPath = null;
    try {
      const formData = await request.formData();
      const pdfFile  = formData.get('pdf');

      if (!pdfFile || typeof pdfFile === 'string') {
        return { status: 400, jsonBody: { error: 'No se recibió archivo PDF.' } };
      }
      if (!pdfFile.name.toLowerCase().endsWith('.pdf')) {
        return { status: 400, jsonBody: { error: 'Solo se permiten archivos PDF.' } };
      }

      const bank = resolveBank(pdfFile.name, formData.get('bank'));
      if (!bank) {
        return {
          status: 400,
          jsonBody: {
            error: `Banco no identificado: ${pdfFile.name}`,
            bancosSoportados: ['BBVA', 'SANTANDER', 'BANAMEX', 'BAJIO', 'BANORTE']
          }
        };
      }

      tempPath = await saveUploadedFile(pdfFile);
      const transactions = await extractTransactions(tempPath, context.log.bind(context), bank);

      if (!transactions.length) {
        return { status: 422, jsonBody: { error: 'No se encontraron transacciones en el PDF.' } };
      }

      const xlsxBuffer = await exportToBuffer(transactions);
      const baseName   = path.basename(pdfFile.name, '.pdf');
      return {
        status:  200,
        body:    xlsxBuffer,
        headers: {
          'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${baseName}.xlsx"`
        }
      };
    } catch (err) {
      context.error('[extract]', err.message, err.stack);
      return {
        status:   500,
        jsonBody: { error: err.message || 'Error interno', stack: err.stack }
      };
    } finally {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }
});

// ── POST /api/bank-extractor/preview ─────────────────────────────────────────
app.http('preview', {
  methods:   ['POST'],
  authLevel: 'anonymous',
  route:     'bank-extractor/preview',
  handler:   async (request, context) => {
    let tempPath = null;
    try {
      const formData = await request.formData();
      const pdfFile  = formData.get('pdf');

      if (!pdfFile || typeof pdfFile === 'string') {
        return { status: 400, jsonBody: { error: 'No se recibió archivo PDF.' } };
      }
      const bank = resolveBank(pdfFile.name, formData.get('bank'));
      if (!bank) {
        return { status: 400, jsonBody: { error: `Banco no identificado: ${pdfFile.name}` } };
      }

      tempPath = await saveUploadedFile(pdfFile);
      const transactions = await extractTransactions(tempPath, context.log.bind(context), bank);

      if (!transactions.length) {
        return { status: 422, jsonBody: { error: 'No se encontraron transacciones.' } };
      }
      return { status: 200, jsonBody: { bank, count: transactions.length, transactions } };
    } catch (err) {
      context.error('[preview]', err.message, err.stack);
      return {
        status:   500,
        jsonBody: { error: err.message || 'Error interno', stack: err.stack }
      };
    } finally {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }
});

// ── POST /api/bank-extractor/extract-from-text ───────────────────────────────
// Recibe el TEXTO por página (OCR hecho en el navegador) y solo parsea + genera
// el Excel. Rápido (<2s) → evita el timeout de 45s de Static Web Apps.
app.http('extractFromText', {
  methods:   ['POST'],
  authLevel: 'anonymous',
  route:     'bank-extractor/extract-from-text',
  handler:   async (request, context) => {
    const log    = (...a) => context.log('[extract-from-text]', ...a);
    const logErr = (...a) => context.error('[extract-from-text]', ...a);
    try {
      const body = await request.json();
      const { filename, pages, usedOcr, bank: bankOverride } = body || {};
      log(`Recibido: ${filename}, ${Array.isArray(pages) ? pages.length : 0} páginas, usedOcr=${!!usedOcr}, banco=${bankOverride || 'auto'}`);

      if (!filename || !Array.isArray(pages) || !pages.length) {
        return { status: 400, jsonBody: { error: 'Faltan filename o pages.' } };
      }
      const bank = resolveBank(filename, bankOverride);
      if (!bank) {
        return { status: 400, jsonBody: { error: `Banco no identificado: ${filename}` } };
      }

      const transactions = await extractTransactionsFromText(filename, pages, {
        usedOcr,
        bank,
        logger: context.log.bind(context)
      });
      log(`Transacciones: ${transactions.length}`);

      if (!transactions.length) {
        return { status: 422, jsonBody: { error: 'No se encontraron transacciones.' } };
      }

      const buffer   = await exportToBuffer(transactions);
      const xlsxName = path.basename(filename, '.pdf') + '.xlsx';
      return {
        status:  200,
        body:    buffer,
        headers: {
          'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${xlsxName}"`
        }
      };
    } catch (err) {
      logErr('ERROR:', err.message, err.stack);
      return {
        status:   500,
        jsonBody: { error: err.message || 'Error interno', stack: err.stack }
      };
    }
  }
});

// ── POST /api/bank-extractor/preview-from-text ───────────────────────────────
// Igual que extract-from-text pero devuelve JSON con las transacciones (vista previa).
app.http('previewFromText', {
  methods:   ['POST'],
  authLevel: 'anonymous',
  route:     'bank-extractor/preview-from-text',
  handler:   async (request, context) => {
    try {
      const body = await request.json();
      const { filename, pages, usedOcr, bank: bankOverride } = body || {};
      if (!filename || !Array.isArray(pages) || !pages.length) {
        return { status: 400, jsonBody: { error: 'Faltan filename o pages.' } };
      }
      const bank = resolveBank(filename, bankOverride);
      if (!bank) {
        return { status: 400, jsonBody: { error: `Banco no identificado: ${filename}` } };
      }
      const transactions = await extractTransactionsFromText(filename, pages, {
        usedOcr,
        bank,
        logger: context.log.bind(context)
      });
      if (!transactions.length) {
        return { status: 422, jsonBody: { error: 'No se encontraron transacciones.' } };
      }
      return { status: 200, jsonBody: { bank, count: transactions.length, transactions } };
    } catch (err) {
      context.error('[preview-from-text]', err.message, err.stack);
      return { status: 500, jsonBody: { error: err.message || 'Error interno', stack: err.stack } };
    }
  }
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.http('health', {
  methods:   ['GET'],
  authLevel: 'anonymous',
  route:     'health',
  handler:   async (_req, _ctx) => ({
    status:   200,
    jsonBody: { status: 'ok', timestamp: new Date().toISOString() }
  })
});
