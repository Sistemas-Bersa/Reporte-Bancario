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

// Convierte "1,234.56" → 1234.56
function _toNum(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace(/,/g, '')) || 0;
}

/**
 * Reconciliación: compara la suma de depósitos/retiros EXTRAÍDA con el TOTAL
 * IMPRESO en el estado de cuenta (buscado en el texto de las páginas). Sirve
 * para avisar al usuario cuándo el OCR de un escaneo no cuadra al 100%.
 *
 * @param {object[]} transactions
 * @param {string[]} pageTexts   Texto por página (para hallar la línea TOTAL)
 * @returns {object|null} { extractedDep, extractedRet, printedDep, printedRet,
 *                          okDep, okRet, status } | null si no se halló TOTAL
 */
function reconcileTotals(transactions, pageTexts) {
  const extractedDep = transactions.reduce((a, t) => a + _toNum(t['MONTO DEPOSITOS']), 0);
  const extractedRet = transactions.reduce((a, t) => a + _toNum(t['MONTO RETIROS']), 0);

  // Buscar la línea de TOTAL con 2 importes grandes (≥ 1,000) en las páginas.
  const AMT = /\d{1,3}(?:,\d{3})*\.\d{2}/g;
  let printedDep = null, printedRet = null;

  // Entre todas las líneas con "TOTAL" y ≥2 importes, elegir la del GRAN TOTAL
  // (la de mayor suma dep+ret). Así evitamos líneas tipo "TOTAL ... 0.00 0.00"
  // o subtotales de sección que pisarían al total real.
  const lines = (pageTexts || []).join('\n').split('\n');
  let bestSum = -1;
  for (const line of lines) {
    if (!/\bTOTAL\b/i.test(line)) continue;
    // Importes con decimales en la línea (los folios no tienen ".dd" → se excluyen)
    const amts = (line.match(AMT) || []).map(_toNum);
    if (amts.length < 2) continue;
    const dep = amts[amts.length - 2];
    const ret = amts[amts.length - 1];
    const sum = dep + ret;
    if (sum > 0 && sum > bestSum) {
      bestSum    = sum;
      printedDep = dep;
      printedRet = ret;
    }
  }

  if (printedDep === null) return null;

  // Tolerancia: 0.1% relativo o $1, lo que sea mayor
  const within = (a, b) => {
    const tol = Math.max(1, Math.abs(b) * 0.001);
    return Math.abs(a - b) <= tol;
  };
  const okDep = within(extractedDep, printedDep);
  const okRet = within(extractedRet, printedRet);

  return {
    extractedDep, extractedRet,
    printedDep,   printedRet,
    okDep, okRet,
    status: (okDep && okRet) ? 'ok' : 'mismatch'
  };
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
  const keys      = Object.keys(transactions[0]);
  const headers   = keys.map(k => k.toUpperCase());
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };

  // Índices de columnas para verificar consistencia por saldo
  const depIdx = keys.indexOf('MONTO DEPOSITOS');
  const retIdx = keys.indexOf('MONTO RETIROS');
  const salIdx = keys.indexOf('SALDO');
  const canCheck = depIdx >= 0 && retIdx >= 0 && salIdx >= 0;

  // Resaltado de filas a revisar: cuando el SALDO no cuadra con el movimiento
  // (depósito − retiro) capturado → el OCR probablemente leyó mal un número.
  const SUSPECT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE08A' } };
  let prevSaldo = null;
  let suspectCount = 0;

  for (const tx of transactions) {
    const values = Object.values(tx);
    const row    = sheet.addRow(values);

    if (canCheck) {
      const cur    = _toNum(values[salIdx]);
      const hasCur = !!values[salIdx] && cur !== 0;
      if (prevSaldo !== null && hasCur) {
        const movimiento = _toNum(values[depIdx]) - _toNum(values[retIdx]); // dep sube, ret baja
        const delta      = cur - prevSaldo;
        const tol        = Math.max(1, Math.abs(delta) * 0.01);
        if (Math.abs(delta - movimiento) > tol) {
          row.eachCell({ includeEmpty: true }, c => { c.fill = SUSPECT_FILL; });
          suspectCount++;
        }
      }
      if (hasCur) prevSaldo = cur;
    }
  }

  // Nota/leyenda al final cuando hay filas marcadas
  if (suspectCount > 0) {
    const note = sheet.addRow([`⚠ ${suspectCount} fila(s) resaltadas: el saldo no cuadra con el monto — revisar (posible error de OCR).`]);
    note.font = { italic: true, color: { argb: 'FF8A6D00' } };
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
  reconcileTotals,
  extractTransactions,
  extractTransactionsFromText,
  exportToFile,
  exportToBuffer,
  processFile
};
