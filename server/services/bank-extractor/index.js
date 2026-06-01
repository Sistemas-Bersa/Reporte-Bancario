'use strict';

const path = require('path');
const ExcelJS = require('exceljs');
const {
  BBVAExtractor,
  SantanderExtractor,
  BanamexExtractor,
  BajioExtractor,
  BanorteExtractor
} = require('./banks');

// Mapa banco → clase extractora
const BANK_MAP = {
  BBVA:      BBVAExtractor,
  SANTANDER: SantanderExtractor,
  BANAMEX:   BanamexExtractor,
  BAJIO:     BajioExtractor,
  BANORTE:   BanorteExtractor
};

/**
 * Detecta el banco a partir del nombre del archivo PDF.
 * @param {string} filename  Nombre o ruta del archivo
 * @returns {string|null}    Clave del banco (ej. 'SANTANDER') o null
 */
// Alias para cubrir typos frecuentes en nombres de archivo
const BANK_ALIASES = {
  'SANTADER': 'SANTANDER',   // "BERSA SANTADER JULIO 223.pdf"
  'SANTANER': 'SANTANDER',
  'BANAMEX':  'BANAMEX',
  'BNORTE':   'BANORTE',
};

function detectBank(filename) {
  const upper = path.basename(filename).toUpperCase();

  // Comprobación directa
  for (const key of Object.keys(BANK_MAP)) {
    if (upper.includes(key)) return key;
  }

  // Comprobación por alias (typos)
  for (const [alias, canonical] of Object.entries(BANK_ALIASES)) {
    if (upper.includes(alias)) return canonical;
  }

  return null;
}

/**
 * Extrae las transacciones de un PDF bancario.
 * @param {string} pdfPath  Ruta absoluta al PDF
 * @returns {Promise<object[]>}  Array de transacciones
 */
// Resuelve el banco: usa el override si es válido, si no detecta por nombre.
function resolveBank(nameOrPath, override) {
  if (override && BANK_MAP[String(override).toUpperCase()]) {
    return String(override).toUpperCase();
  }
  return detectBank(nameOrPath);
}

async function extractTransactions(pdfPath, logger = console.log, bankOverride = null) {
  const bankKey = resolveBank(pdfPath, bankOverride);
  if (!bankKey) {
    throw new Error(`No se pudo detectar el banco para: ${path.basename(pdfPath)}`);
  }
  const ExtractorClass = BANK_MAP[bankKey];
  const extractor = new ExtractorClass(pdfPath, logger);
  return extractor.extractTransactions();
}

/**
 * Extrae transacciones a partir de TEXTO ya extraído por página
 * (típicamente OCR realizado en el navegador). NO usa pdfjs ni OCR en servidor,
 * por lo que es rápido (<2s) y evita el timeout de Static Web Apps.
 *
 * @param {string}   filename   Nombre del archivo (para detectar banco)
 * @param {string[]} pageTexts  Texto reconstruido por página
 * @param {object}   opts       { usedOcr, logger }
 * @returns {Promise<object[]>}
 */
async function extractTransactionsFromText(filename, pageTexts, opts = {}) {
  const { usedOcr = false, logger = console.log, bank = null } = opts;
  const bankKey = resolveBank(filename, bank);
  if (!bankKey) {
    throw new Error(`No se pudo detectar el banco para: ${path.basename(filename)}`);
  }
  if (!Array.isArray(pageTexts) || !pageTexts.length) {
    throw new Error('No se recibió texto de páginas para procesar.');
  }
  const ExtractorClass = BANK_MAP[bankKey];
  const extractor = new ExtractorClass(filename, logger, pageTexts);
  // El OCR se hizo en el cliente → aplicar correcciones OCR si corresponde
  extractor.usedOcr = !!usedOcr;
  return extractor.extractTransactions();
}

/**
 * Exporta transacciones a un archivo .xlsx en disco.
 * @param {object[]} transactions
 * @param {string}   outputPath   Ruta completa del archivo de salida
 * @returns {Promise<string>}  La misma ruta de salida
 */
async function exportToFile(transactions, outputPath) {
  const workbook = _buildWorkbook(transactions);
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

/**
 * Exporta transacciones a un Buffer en memoria (útil para respuesta HTTP).
 * @param {object[]} transactions
 * @returns {Promise<Buffer>}
 */
async function exportToBuffer(transactions) {
  const workbook = _buildWorkbook(transactions);
  return workbook.xlsx.writeBuffer();
}

/**
 * Función de conveniencia: extrae un PDF y lo guarda como .xlsx
 * en el mismo directorio (o en outputDir si se especifica).
 * @param {string}      pdfPath
 * @param {string|null} outputDir  Carpeta destino (opcional)
 * @returns {Promise<string|null>}  Ruta del Excel generado, o null si no hay datos
 */
async function processFile(pdfPath, outputDir = null) {
  const transactions = await extractTransactions(pdfPath);
  if (!transactions.length) return null;

  const baseName  = path.basename(pdfPath, '.pdf');
  const targetDir = outputDir || path.dirname(pdfPath);
  const outputPath = path.join(targetDir, `${baseName}.xlsx`);

  return exportToFile(transactions, outputPath);
}

// ─── helpers internos ────────────────────────────────────────────────────────

function _buildWorkbook(transactions) {
  if (!transactions.length) throw new Error('No hay transacciones para exportar.');

  const workbook = new ExcelJS.Workbook();
  const sheet    = workbook.addWorksheet('Transacciones');

  // Encabezados en mayúsculas
  const headers = Object.keys(transactions[0]).map(k => k.toUpperCase());
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };

  for (const tx of transactions) {
    sheet.addRow(Object.values(tx));
  }

  // Ajuste automático de ancho de columna
  sheet.columns.forEach(col => {
    let maxLen = 10;
    col.eachCell({ includeEmpty: true }, cell => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 2, 60);
  });

  return workbook;
}

module.exports = {
  detectBank,
  resolveBank,
  extractTransactions,
  extractTransactionsFromText,
  exportToFile,
  exportToBuffer,
  processFile
};
