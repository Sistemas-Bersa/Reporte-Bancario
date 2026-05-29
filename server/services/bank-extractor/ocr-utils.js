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
 * Tesseract.js lo usará en lugar de descargarlo desde la CDN.
 * __dirname → server/services/bank-extractor/  →  ../.. → server/
 */
const LANG_PATH = path.join(__dirname, '../..');

/**
 * OCRea una página de PDF usando pdfjs-dist (render) + tesseract.js.
 * Compatible con Azure Functions (Linux) y Node.js local.
 */
async function ocrPage(pdfPath, pageIndex) {
  let doc = null;
  let cc  = null;
  try {
    const pdfjsLib  = require('pdfjs-dist/legacy/build/pdf.js');
    const Tesseract = require('tesseract.js');

    const data          = new Uint8Array(fs.readFileSync(pdfPath));
    const canvasFactory = new NodeCanvasFactory();

    doc = await pdfjsLib.getDocument({ data, canvasFactory }).promise;
    const page = await doc.getPage(pageIndex + 1);

    // En Azure reducimos a 200 DPI para ahorrar memoria; local a 300 DPI
    const scale    = process.env.FUNCTIONS_WORKER_RUNTIME ? 2 : 3;
    const viewport = page.getViewport({ scale });
    cc             = canvasFactory.create(viewport.width, viewport.height);

    await page.render({ canvasContext: cc.context, viewport }).promise;
    await page.cleanup();

    // @napi-rs/canvas usa encode() async, no toBuffer()
    const imageBuffer = await cc.canvas.encode('png');

    const { data: { text } } = await Tesseract.recognize(imageBuffer, 'spa', {
      langPath: LANG_PATH, // usa spa.traineddata local — sin descarga CDN
      gzip:     false,
      logger:   () => {}
    });

    return text || '';
  } catch (err) {
    console.error(`Error OCR página ${pageIndex}:`, err.message);
    return '';
  } finally {
    // Liberar memoria explícitamente en cada página
    if (cc)  cc.canvas.width = cc.canvas.height = 0;
    if (doc) await doc.destroy().catch(() => {});
  }
}

module.exports = { ocrPage };
