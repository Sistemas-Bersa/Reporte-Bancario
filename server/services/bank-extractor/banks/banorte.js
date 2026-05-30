'use strict';

const { BankExtractorBase } = require('../base');

class BanorteExtractor extends BankExtractorBase {
  constructor(pdfPath, logger, pageTexts) {
    super(pdfPath, logger, pageTexts);
    this.bankName = 'Banorte';
  }

  async extractTransactions() {
    this.transactions = [];

    try {
      await this._extractWithXPositions();
    } catch (err) {
      console.error(`Error procesando Banorte ${this.pdfPath}:`, err.message);
    }

    return this.transactions;
  }

  /**
   * Extractor Banorte basado en posición X de los ítems de pdfjs-dist.
   *
   * Estrategia:
   *  1. Agrupar ítems por fila (Y coordinate).
   *  2. Usar regex en el texto de la fila para detectar inicio de transacción (fecha DD-MON-YY).
   *  3. Usar la posición X del ítem numérico para determinar columna:
   *       DEPOSITO (~381–398)  |  RETIRO (~451–475)  |  SALDO (~523+, ignorar)
   *
   * Columnas Banorte típicas (Enlace Global):
   *   FECHA | DESCRIPCIÓN              | MONTO DEL DEPOSITO (~390) | MONTO DEL RETIRO (~465) | SALDO (~523+)
   */
  async _extractWithXPositions() {
    const fs       = require('fs');
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

    const data = new Uint8Array(fs.readFileSync(this.pdfPath));
    const doc  = await pdfjsLib.getDocument({ data }).promise;

    const AMOUNT_RE = /^\d{1,3}(?:,\d{3})*\.\d{2}$/;
    // Fecha Banorte: "01-JUL-24", "31-DIC-24", etc.
    const TX_DATE_RE = /^(\d{2}-[A-Z]{3}-\d{2})\s*(.*?)$/i;

    // Posiciones X de columnas (se auto-detectan desde la cabecera; valores por defecto)
    let xDepositoCenter = 390;  // centro de la columna MONTO DEL DEPOSITO
    let xRetiroCenter   = 465;  // centro de la columna MONTO DEL RETIRO
    let xSaldoStart     = 520;  // borde izquierdo de la columna SALDO

    let currentTx = null;

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc   = await page.getTextContent();
      const items = tc.items.filter(i => typeof i.str === 'string' && i.str.trim());

      // ── Agrupar ítems en líneas (Y_TOLERANCE = 3) ──────────────────
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

        // ── 1. Auto-detectar posiciones de columnas desde la cabecera ──
        //    La línea de encabezado contiene DEPOSITO, RETIRO y SALDO
        if (/\bDEPOSITO\b/i.test(lineTextFull) &&
            /\bRETIRO\b/i.test(lineTextFull)   &&
            /\bSALDO\b/i.test(lineTextFull)) {
          const depItem  = words.find(w => /^DEPOSITO$/i.test(w.str));
          const retItem  = words.find(w => /^RETIRO$/i.test(w.str));
          const saldItem = words.find(w => /^SALDO$/i.test(w.str));
          if (depItem)  xDepositoCenter = depItem.x + (depItem.w || 0) / 2;
          if (retItem)  xRetiroCenter   = retItem.x + (retItem.w || 0) / 2;
          if (saldItem) xSaldoStart     = saldItem.x;
          continue;
        }

        // ── 2. Saltar cabeceras / pies de página ───────────────────────
        if (/ESTADO DE CUENTA|ENLACE GLOBAL|DETALLE DE MOVIMIENTOS|SALDO ANTERIOR|INVERSION|PAGINA\s+\d/i.test(lineTextFull)) {
          continue;
        }

        // ── 3. Separar ítems numéricos (montos) de texto ───────────────
        const amountItems = words.filter(w => AMOUNT_RE.test(w.str.replace(/\s/g, '')));
        const textItems   = words.filter(w => !AMOUNT_RE.test(w.str.replace(/\s/g, '')));
        const lineText    = textItems.map(w => w.str).join(' ').trim();

        // ── 4. Detectar si la línea inicia una transacción ─────────────
        const txMatch = TX_DATE_RE.exec(lineText);

        if (txMatch) {
          const [, fecha, concepto] = txMatch;

          // Saltar líneas especiales de saldo
          if (/SALDO\s+(INICIAL|FINAL|ANTERIOR|PROMEDIO)|TOTAL\s+DE\s+(DEP|RET)/i.test(concepto)) {
            continue;
          }

          // Guardar tx anterior
          if (currentTx) this.transactions.push(currentTx);

          // Clasificar montos por posición X
          let montoDeposito = '';
          let montoRetiro   = '';
          let saldo         = '';

          const xMidpoint   = (xDepositoCenter + xRetiroCenter) / 2;
          const xSaldoCutoff = xSaldoStart - 10;

          for (const ai of amountItems) {
            const cx = ai.x + (ai.w || 0) / 2;
            if (cx >= xSaldoCutoff) {
              saldo = ai.str;             // columna SALDO → guardar pero no como movimiento
            } else if (cx < xMidpoint) {
              montoDeposito = ai.str;     // columna DEPOSITO
            } else {
              montoRetiro = ai.str;       // columna RETIRO
            }
          }

          currentTx = {
            'Fecha':               fecha,
            'DESCRIPCION':         concepto.trim(),
            'MONTO DEL DEPOSITO':  montoDeposito,
            'MONTO DEL RETIRO':    montoRetiro,
            'Saldo':               saldo
          };

        } else if (currentTx) {
          // ── 5. Línea de continuación ────────────────────────────────
          // Ignorar líneas que solo contienen dígitos o referencias numéricas
          const isOnlyDigits = textItems.every(w => /^\d+$/.test(w.str));
          if (isOnlyDigits && !amountItems.length) continue;

          if (lineText) {
            currentTx['DESCRIPCION'] = (currentTx['DESCRIPCION'] + ' ' + lineText).trim();
          }
        }
      }

      await page.cleanup();
    }

    if (currentTx) this.transactions.push(currentTx);
    await doc.destroy();

    // Filtrar filas sin monto de movimiento
    this.transactions = this.transactions.filter(
      tx => tx['MONTO DEL DEPOSITO'] || tx['MONTO DEL RETIRO']
    );
  }
}

module.exports = { BanorteExtractor };
