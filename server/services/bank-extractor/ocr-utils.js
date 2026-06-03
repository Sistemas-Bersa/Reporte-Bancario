'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * NodeCanvasFactory personalizada que usa @napi-rs/canvas.
 * pdfjs-dist necesita esto para renderizar páginas a imagen sin
 * depender del paquete 'canvas' (que no compila en Node.js v24).
 */
class NodeCanvasFactory {
  create(width, height) {
    const { createCanvas } = require('@napi-rs/canvas');
    const canvas  = createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  }
  reset(cc, width, height) {
    cc.canvas.width  = width;
    cc.canvas.height = height;
  }
  destroy(cc) {
    // Liberar memoria explícitamente
    cc.canvas.width  = 0;
    cc.canvas.height = 0;
  }
}

/**
 * Directorio que contiene spa.traineddata (incluido en el repo).
 * __dirname → server/services/bank-extractor/  →  ../.. → server/
 */
const LANG_PATH = path.join(__dirname, '../..');

// ── Worker Tesseract compartido ───────────────────────────────────────────────
// Crear el worker UNA sola vez y reutilizarlo para todas las páginas del lote.
// Evita 56× init de WASM (~50 MB cada uno) en documentos escaneados grandes.
let _worker     = null;
let _workerBusy = false;

async function _getWorker() {
  if (_worker) return _worker;
  const Tesseract = require('tesseract.js');
  _worker = await Tesseract.createWorker('spa', 1, {
    langPath: LANG_PATH,
    gzip:     false,
    logger:   () => {}
  });
  return _worker;
}

/** Termina el worker compartido (llamar al final del lote OCR). */
async function terminateOcrWorker() {
  if (_worker) {
    await _worker.terminate().catch(() => {});
    _worker     = null;
    _workerBusy = false;
  }
}

/** Devuelve el uso de memoria en MB como string compacto para logs. */
function memSnapshot() {
  const m = process.memoryUsage();
  const mb = b => Math.round(b / 1024 / 1024);
  return `rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB external=${mb(m.external)}MB`;
}

/**
 * OCRea una página de PDF usando pdfjs-dist (render) + tesseract.js.
 * Reutiliza un worker compartido para minimizar el uso de memoria.
 * @param {string}   pdfPath
 * @param {number}   pageIndex
 * @param {Function} logger  Función de log (por defecto console.log)
 */
async function ocrPage(pdfPath, pageIndex, logger = console.log) {
  const log = (...a) => logger('[ocr-utils]', ...a);
  let doc = null;
  let cc  = null;
  log(`Página ${pageIndex + 1}: inicio OCR | mem ${memSnapshot()}`);
  try {
    const pdfjsLib      = require('pdfjs-dist/legacy/build/pdf.js');
    const data          = new Uint8Array(fs.readFileSync(pdfPath));
    const canvasFactory = new NodeCanvasFactory();

    doc = await pdfjsLib.getDocument({ data, canvasFactory }).promise;
    const page = await doc.getPage(pageIndex + 1);

    // Escala según entorno. En Azure (RAM limitada) usamos 1.5 para evitar OOM
    // en el render del canvas; local 3 para máxima calidad.
    // Override opcional con OCR_SCALE (útil para pruebas comparables al navegador).
    const scale = process.env.OCR_SCALE
      ? Number(process.env.OCR_SCALE)
      : (process.env.FUNCTIONS_WORKER_RUNTIME ? 1.5 : 3);
    const viewport = page.getViewport({ scale });
    log(`Página ${pageIndex + 1}: render scale=${scale} ${Math.round(viewport.width)}x${Math.round(viewport.height)}px`);
    cc             = canvasFactory.create(viewport.width, viewport.height);

    await page.render({ canvasContext: cc.context, viewport }).promise;
    await page.cleanup();

    const imageBuffer = await cc.canvas.encode('png');
    log(`Página ${pageIndex + 1}: PNG ${Math.round(imageBuffer.length / 1024)}KB | mem ${memSnapshot()}`);

    // Liberar el canvas ANTES del OCR para no sumar su memoria a la de Tesseract
    cc.canvas.width = cc.canvas.height = 0;
    cc = null;
    await doc.destroy().catch(() => {});
    doc = null;

    // Usar worker compartido (WASM cargado una sola vez)
    const worker         = await _getWorker();
    const { data: { text } } = await worker.recognize(imageBuffer);
    log(`Página ${pageIndex + 1}: OCR completado, ${(text || '').length} chars | mem ${memSnapshot()}`);

    return text || '';
  } catch (err) {
    log(`ERROR OCR página ${pageIndex + 1}: ${err.message} | mem ${memSnapshot()}`);
    log(`Stack: ${err.stack}`);
    throw err;
  } finally {
    if (cc)  cc.canvas.width = cc.canvas.height = 0;
    if (doc) await doc.destroy().catch(() => {});
    // Sugerir GC si el runtime se inició con --expose-gc
    if (global.gc) { try { global.gc(); } catch { /* noop */ } }
  }
}

module.exports = { ocrPage, terminateOcrWorker };
