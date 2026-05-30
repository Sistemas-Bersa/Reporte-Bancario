'use strict';

const { BankExtractorBase } = require('../base');

class BanamexExtractor extends BankExtractorBase {
  constructor(pdfPath, logger, pageTexts) {
    super(pdfPath, logger, pageTexts);
    this.bankName = 'Banamex';
  }

  async extractTransactions() {
    this.transactions = [];
    try {
      await this._extractWithXPositions();
    } catch (err) {
      console.error(`Error procesando Banamex ${this.pdfPath}:`, err.message);
    }
    return this.transactions;
  }

  /**
   * Extractor Banamex basado en posición X de los ítems de pdfjs-dist.
   *
   * Estrategia (páginas digitales):
   *  1. Agrupar ítems por fila (Y coordinate).
   *  2. Detectar inicio de transacción: línea con fecha "DD MON" al comienzo.
   *  3. Detectar línea HORA: contiene el monto real de la operación.
   *  4. Usar la posición X del monto en la línea HORA para clasificar RETIRO/DEPOSITO.
   *
   * Columnas Banamex típicas:
   *   FECHA | CONCEPTO          | RETIROS (~265-300) | DEPOSITOS (~337-390) | SALDO (~426+)
   *
   * Páginas escaneadas (OCR): fallback a keyword matching (RECIBIDO|DEPOSITO|ABONO).
   */
  async _extractWithXPositions() {
    const fs       = require('fs');
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

    const data = new Uint8Array(fs.readFileSync(this.pdfPath));
    const doc  = await pdfjsLib.getDocument({ data }).promise;

    const AMOUNT_RE  = /^\d{1,3}(?:,\d{3})*\.\d{2}$/;
    // Fecha Banamex: "01 JUL", "31 DIC", etc.
    const TX_DATE_RE = /^(\d{1,2}\s+[A-Z]{3})\s+(.*?)$/i;
    const HORA_RE    = /^(?:HORA\s+\d{2}:\d{2}|CAJA\s+\d+\s+AUT\s+\d+\s+HORA\s+\d{2}:\d{2})/i;

    // Posiciones X de columnas (se auto-detectan desde el encabezado; valores por defecto)
    let xRetiroCenter   = 283;  // centro columna RETIROS
    let xDepositoCenter = 360;  // centro columna DEPOSITOS
    let xSaldoStart     = 426;  // borde izquierdo columna SALDO

    let currentTx = null;

    for (let p = 1; p <= doc.numPages; p++) {
      const page  = await doc.getPage(p);
      const tc    = await page.getTextContent();
      const items = tc.items.filter(i => typeof i.str === 'string' && i.str.trim());

      // ── Detectar si la página es escaneada (< 50 chars de texto pdfjs) ──────
      const rawText = items.map(i => i.str).join('');
      if (rawText.trim().length < 50) {
        // Página escaneada — usar OCR + fallback keyword
        try {
          this.usedOcr = true;
          const { ocrPage } = require('../ocr-utils');
          const ocrText = await ocrPage(this.pdfPath, p - 1);
          currentTx = this._processOcrLines(ocrText, currentTx);
        } catch (e) {
          // Si OCR falla, omitir la página
        }
        await page.cleanup();
        continue;
      }

      // ── Agrupar ítems en líneas (Y_TOLERANCE = 3) ────────────────────────────
      const lineMap = new Map();
      for (const item of items) {
        const y = item.transform[5];
        let matchedY = null;
        for (const ey of lineMap.keys()) {
          if (Math.abs(ey - y) <= 3) { matchedY = ey; break; }
        }
        const key = matchedY !== null ? matchedY : y;
        if (!lineMap.has(key)) lineMap.set(key, []);
        lineMap.get(key).push({
          x:   item.transform[4],
          str: item.str.trim(),
          w:   item.width || 0
        });
      }

      const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);

      for (const y of sortedYs) {
        const words = lineMap.get(y).sort((a, b) => a.x - b.x);
        const lineTextFull = words.map(w => w.str).join(' ');

        // ── 1. Auto-detectar posiciones de columnas desde el encabezado ──────
        //    La línea encabezado contiene RETIROS, DEPOSITOS y SALDO
        if (/\bRETIROS\b/i.test(lineTextFull) &&
            /\bDEPOSITOS\b/i.test(lineTextFull) &&
            /\bSALDO\b/i.test(lineTextFull)) {
          const retItem  = words.find(w => /^RETIROS$/i.test(w.str));
          const depItem  = words.find(w => /^DEPOSITOS$/i.test(w.str));
          const saldItem = words.find(w => /^SALDO$/i.test(w.str));
          if (retItem)  xRetiroCenter   = retItem.x  + (retItem.w  || 0) / 2;
          if (depItem)  xDepositoCenter = depItem.x  + (depItem.w  || 0) / 2;
          if (saldItem) xSaldoStart     = saldItem.x;
          continue;
        }

        // ── 2. Saltar cabeceras / pies de página ──────────────────────────────
        if (/ESTADO DE CUENTA|DETALLE DE OPERACIONES|CLIENTE:|P[aá]gina:/i.test(lineTextFull)) continue;
        if (/^FECHA\s+CONCEPTO/i.test(lineTextFull)) continue;

        // ── 3. Separar montos de texto ────────────────────────────────────────
        const amountItems = words.filter(w => AMOUNT_RE.test(w.str.replace(/\s/g, '')));
        const textItems   = words.filter(w => !AMOUNT_RE.test(w.str.replace(/\s/g, '')));
        const lineText    = textItems.map(w => w.str).join(' ').trim();

        // ── 4. Detectar inicio de transacción (línea con fecha DD MON) ───────
        const txMatch = TX_DATE_RE.exec(lineText);
        if (txMatch && !/ESTADO DE CUENTA|RESUMEN|SALDO\s+(ANTERIOR|FINAL|AL\s+\d)/i.test(lineText)) {
          // Guardar tx anterior si tenía monto (caso raro: tx sin HORA)
          if (currentTx && (currentTx['Monto DEPOSITOS'] || currentTx['Monto RETIROS'])) {
            this.transactions.push(currentTx);
          }
          const [, fecha, concepto] = txMatch;
          currentTx = {
            'Fecha':           fecha,
            'Concepto':        concepto.trim(),
            'Monto DEPOSITOS': '',
            'Monto RETIROS':   '',
            'Saldo':           ''
          };
          continue;
        }

        // ── 5. Detectar línea HORA (monto real de la operación) ──────────────
        if (HORA_RE.test(lineText) && currentTx) {
          const xMidpoint    = (xRetiroCenter + xDepositoCenter) / 2;
          const xSaldoCutoff = xSaldoStart - 10;

          for (const ai of amountItems) {
            const cx = ai.x + (ai.w || 0) / 2;
            if (cx >= xSaldoCutoff) {
              currentTx['Saldo'] = ai.str;            // columna SALDO → solo guardar
            } else if (cx < xMidpoint) {
              currentTx['Monto RETIROS'] = ai.str;    // columna RETIROS
            } else {
              currentTx['Monto DEPOSITOS'] = ai.str;  // columna DEPOSITOS
            }
          }

          // La línea HORA finaliza la transacción
          if (currentTx['Monto DEPOSITOS'] || currentTx['Monto RETIROS']) {
            this.transactions.push(currentTx);
          }
          currentTx = null;
          continue;
        }

        // ── 6. Línea de continuación ──────────────────────────────────────────
        if (currentTx && lineText) {
          currentTx['Concepto'] = (currentTx['Concepto'] + '\n' + lineText).trim();
        }
      }

      await page.cleanup();
    }

    // Guardar última transacción pendiente
    if (currentTx && (currentTx['Monto DEPOSITOS'] || currentTx['Monto RETIROS'])) {
      this.transactions.push(currentTx);
    }

    await doc.destroy();

    // Filtrar filas sin monto
    this.transactions = this.transactions.filter(
      tx => tx['Monto DEPOSITOS'] || tx['Monto RETIROS']
    );
  }

  /**
   * Procesa líneas de texto OCR (páginas escaneadas).
   * Fallback: usa keyword matching para clasificar depósito vs retiro.
   */
  _processOcrLines(ocrText, currentTx) {
    const TX_DATE_RE = /^\s*(\d{1,2}\s+[A-Z]{3})\s+(.*)/i;
    const HORA_RE    = /HORA\s+\d{2}:\d{2}(?:\s+SUC\s+\d+)?\s+([\d,]+\.\d{2})(?:\s+([\d,]+\.\d{2}))?/i;

    for (const line of ocrText.split('\n')) {
      if (/ESTADO DE CUENTA|CLIENTE:|P[aá]gina:|DETALLE DE OPERACIONES/i.test(line)) continue;
      if (/^FECHA\s+CONCEPTO/i.test(line)) continue;

      const startMatch = TX_DATE_RE.exec(line);
      if (startMatch && !/RESUMEN|SALDO\s+(ANTERIOR|FINAL|AL\s+\d)/i.test(line)) {
        if (currentTx && (currentTx['Monto DEPOSITOS'] || currentTx['Monto RETIROS'])) {
          this.transactions.push(currentTx);
        }
        currentTx = {
          'Fecha':           startMatch[1],
          'Concepto':        startMatch[2].trim(),
          'Monto DEPOSITOS': '',
          'Monto RETIROS':   '',
          'Saldo':           ''
        };
        continue;
      }

      if (currentTx) {
        const horaMatch = HORA_RE.exec(line);
        if (horaMatch) {
          const monto      = horaMatch[1];
          const esDeposito = /RECIBIDO|DEPOSITO|ABONO/i.test(currentTx['Concepto']);
          if (esDeposito) {
            currentTx['Monto DEPOSITOS'] = monto;
          } else {
            currentTx['Monto RETIROS'] = monto;
          }
          if (horaMatch[2]) currentTx['Saldo'] = horaMatch[2];
          this.transactions.push(currentTx);
          currentTx = null;
        } else {
          currentTx['Concepto'] = (currentTx['Concepto'] + '\n' + line.trim()).trim();
        }
      }
    }

    return currentTx;
  }
}

module.exports = { BanamexExtractor };
