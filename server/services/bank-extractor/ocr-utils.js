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

/**
 * OCRea una página de PDF usando pdfjs-dist (render) + tesseract.js.
 * Reutiliza un worker compartido para minimizar el uso de memoria.
 */
async function ocrPage(pdfPath, pageIndex) {
  let doc = null;
  let cc  = null;
  try {
    const pdfjsLib      = require('pdfjs-dist/legacy/build/pdf.js');
    const data          = new Uint8Array(fs.readFileSync(pdfPath));
    const canvasFactory = new NodeCanvasFactory();

    doc = await pdfjsLib.getDocument({ data, canvasFactory }).promise;
    const page = await doc.getPage(pageIndex + 1);

    // En Azure: 200 DPI para ahorrar memoria; local: 300 DPI
    const scale    = process.env.FUNCTIONS_WORKER_RUNTIME ? 2 : 3;
    const viewport = page.getViewport({ scale });
    cc             = canvasFactory.create(viewport.width, viewport.height);

    await page.render({ canvasContext: cc.context, viewport }).promise;
    await page.cleanup();

    const imageBuffer = await cc.canvas.encode('png');

    // Usar worker compartido (WASM cargado una sola vez)
    const worker         = await _getWorker();
    const { data: { text } } = await worker.recognize(imageBuffer);

    return text || '';
  } catch (err) {
    console.error(`Error OCR página ${pageIndex}:`, err.message);
    return '';
  } finally {
    if (cc)  cc.canvas.width = cc.canvas.height = 0;
    if (doc) await doc.destroy().catch(() => {});
  }
}

module.exports = { ocrPage, terminateOcrWorker };
