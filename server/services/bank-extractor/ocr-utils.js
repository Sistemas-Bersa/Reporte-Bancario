'use strict';

const fs = require('fs');

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
    cc.canvas.width  = 0;
    cc.canvas.height = 0;
  }
}

/**
 * OCRea una página de PDF usando pdfjs-dist (render) + tesseract.js.
 * Reemplaza el winrt (Windows Runtime) original — compatible con Azure Linux.
 */
async function ocrPage(pdfPath, pageIndex) {
  try {
    const pdfjsLib  = require('pdfjs-dist/legacy/build/pdf.js');
    const Tesseract = require('tesseract.js');

    const data           = new Uint8Array(fs.readFileSync(pdfPath));
    const canvasFactory  = new NodeCanvasFactory();

    const doc  = await pdfjsLib.getDocument({ data, canvasFactory }).promise;
    const page = await doc.getPage(pageIndex + 1);

    const scale    = 3; // ≈ 300 DPI
    const viewport = page.getViewport({ scale });
    const cc       = canvasFactory.create(viewport.width, viewport.height);

    await page.render({ canvasContext: cc.context, viewport }).promise;
    await doc.destroy();

    // @napi-rs/canvas usa encode() async, no toBuffer()
    const imageBuffer = await cc.canvas.encode('png');

    const { data: { text } } = await Tesseract.recognize(imageBuffer, 'spa', {
      logger: () => {}
    });

    return text || '';
  } catch (err) {
    console.error(`Error OCR página ${pageIndex}:`, err.message);
    return '';
  }
}

module.exports = { ocrPage };
