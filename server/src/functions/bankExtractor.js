'use strict';

/**
 * Azure Functions v4 — Extractor Bancario PDF → Excel
 *
 * Estos handlers reemplazan las rutas Express para el despliegue en
 * Azure Static Web Apps. En desarrollo local se puede usar tanto el
 * servidor Express (node index.js) como Azure Functions Core Tools
 * (func start).
 *
 * Rutas expuestas:
 *   POST /api/bank-extractor/extract          → un PDF  → .xlsx
 *   POST /api/bank-extractor/extract-multiple → N PDFs  → .zip
 *   POST /api/bank-extractor/preview          → un PDF  → JSON
 *   GET  /api/health                          → health check
 */

const { app }    = require('@azure/functions');
const archiver   = require('archiver');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');
const {
  detectBank,
  extractTransactions,
  exportToBuffer
} = require('../../services/bank-extractor');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Lee un archivo del FormData de la petición y lo guarda en /tmp.
 * Devuelve la ruta temporal; el llamador es responsable de borrarlo.
 */
async function saveUploadedFile(file) {
  const buffer   = Buffer.from(await file.arrayBuffer());
  const tempPath = path.join(os.tmpdir(), `${Date.now()}_${path.basename(file.name)}`);
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}

/** Comprime varios buffers en un ZIP y devuelve el Buffer resultante. */
async function buildZip(entries) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks  = [];
  archive.on('data', c => chunks.push(c));

  const done = new Promise((resolve, reject) => {
    archive.on('end',   resolve);
    archive.on('error', reject);
  });

  for (const { name, buffer } of entries) {
    archive.append(buffer, { name });
  }
  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

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

      const bank = detectBank(pdfFile.name);
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
      const transactions = await extractTransactions(tempPath);

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
      context.error('[extract]', err.message);
      return { status: 500, jsonBody: { error: err.message } };
    } finally {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }
});

// ── POST /api/bank-extractor/extract-multiple ─────────────────────────────────
app.http('extractMultiple', {
  methods:   ['POST'],
  authLevel: 'anonymous',
  route:     'bank-extractor/extract-multiple',
  handler:   async (request, context) => {
    const tempPaths = [];
    try {
      const formData = await request.formData();
      const files    = formData.getAll('pdfs').filter(f => typeof f !== 'string');

      if (!files.length) {
        return { status: 400, jsonBody: { error: 'No se recibieron archivos PDF.' } };
      }

      const results = [];

      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.pdf')) {
          results.push({ name: file.name, error: 'No es un PDF', buffer: null });
          continue;
        }

        const bank = detectBank(file.name);
        if (!bank) {
          results.push({ name: file.name, error: 'Banco no identificado', buffer: null });
          continue;
        }

        let tempPath = null;
        try {
          tempPath = await saveUploadedFile(file);
          tempPaths.push(tempPath);

          const transactions = await extractTransactions(tempPath);
          if (!transactions.length) {
            results.push({ name: file.name, error: 'Sin transacciones', buffer: null });
          } else {
            const buffer   = await exportToBuffer(transactions);
            const xlsxName = path.basename(file.name, '.pdf') + '.xlsx';
            results.push({ name: xlsxName, error: null, buffer, count: transactions.length });
          }
        } catch (e) {
          results.push({ name: file.name, error: e.message, buffer: null });
        }
      }

      const successful = results.filter(r => r.buffer);
      if (!successful.length) {
        return {
          status: 422,
          jsonBody: {
            error:    'Ningún archivo generó transacciones.',
            detalles: results.map(r => ({ archivo: r.name, error: r.error }))
          }
        };
      }

      // Un solo archivo con éxito → devolver xlsx directo
      if (successful.length === 1 && results.length === 1) {
        return {
          status:  200,
          body:    successful[0].buffer,
          headers: {
            'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${successful[0].name}"`
          }
        };
      }

      // Varios archivos → ZIP
      const zipEntries = successful.map(r => ({ name: r.name, buffer: r.buffer }));
      const failed     = results.filter(r => r.error);
      if (failed.length) {
        const summary = failed.map(r => `${r.name}: ${r.error}`).join('\n');
        zipEntries.push({ name: '_errores.txt', buffer: Buffer.from(summary) });
      }

      const zipBuffer = await buildZip(zipEntries);
      return {
        status:  200,
        body:    zipBuffer,
        headers: {
          'Content-Type':        'application/zip',
          'Content-Disposition': 'attachment; filename="estados_de_cuenta.zip"'
        }
      };
    } catch (err) {
      context.error('[extract-multiple]', err.message);
      return { status: 500, jsonBody: { error: err.message } };
    } finally {
      for (const p of tempPaths) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
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

      const bank = detectBank(pdfFile.name);
      if (!bank) {
        return { status: 400, jsonBody: { error: `Banco no identificado: ${pdfFile.name}` } };
      }

      tempPath = await saveUploadedFile(pdfFile);
      const transactions = await extractTransactions(tempPath);

      if (!transactions.length) {
        return { status: 422, jsonBody: { error: 'No se encontraron transacciones.' } };
      }

      return { status: 200, jsonBody: { bank, count: transactions.length, transactions } };
    } catch (err) {
      context.error('[preview]', err.message);
      return { status: 500, jsonBody: { error: err.message } };
    } finally {
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }
});

// ── GET /api/health ───────────────────────────────────────────────────────────
app.http('health', {
  methods:   ['GET'],
  authLevel: 'anonymous',
  route:     'health',
  handler:   async (_request, _context) => ({
    status:   200,
    jsonBody: { status: 'ok', timestamp: new Date().toISOString() }
  })
});
