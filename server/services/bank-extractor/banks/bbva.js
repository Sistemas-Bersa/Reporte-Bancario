'use strict';

const { BankExtractorBase } = require('../base');

class BBVAExtractor extends BankExtractorBase {
  constructor(pdfPath, logger, pageTexts) {
    super(pdfPath, logger, pageTexts);
    this.bankName = 'BBVA';
  }

  async extractTransactions() {
    this.transactions = [];

    try {
      await this._extractWithXPositions();
    } catch (err) {
      console.error(`Error procesando BBVA ${this.pdfPath}:`, err.message);
    }

    return this.transactions;
  }

  /**
   * Extractor BBVA basado en posición X de los ítems de pdfjs-dist.
   *
   * Estrategia:
   *  1. Agrupar ítems por fila (Y coordinate).
   *  2. Usar regex en el texto de la fila para extraer fecha/código/concepto.
   *  3. Usar la posición X del ítem numérico para determinar si es CARGO o ABONO
   *     (más confiable que palabras clave).
   *
   * Columnas BBVA típicas:
   *   COD | DESCRIPCIÓN              | CARGOS (~360-385) | ABONOS (~405-435) | SALDO (~480+)
   */
  async _extractWithXPositions() {
    const fs       = require('fs');
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

    const data = new Uint8Array(fs.readFileSync(this.pdfPath));
    const doc  = await pdfjsLib.getDocument({ data }).promise;

    const AMOUNT_RE = /^\d{1,3}(?:,\d{3})*\.\d{2}$/;
    // Fecha BBVA: "01/JUL", "31/DIC", etc.
    const TX_LINE_RE = /^(\d{2}\/[A-Z]{3})\s+(\d{2}\/[A-Z]{3})\s+([A-Z0-9]+)\s*(.*?)$/i;

    // Límites X de columnas (se auto-detectan; valores por defecto)
    let xCargosCenter = 370;   // centro de la columna CARGOS
    let xAbonosCenter = 420;   // centro de la columna ABONOS
    let xSaldoStart   = 490;   // borde izquierdo de la primera columna SALDO (OPERACIÓN)
    // Cualquier monto cuyo cx >= xSaldoStart - 10 se ignora (es columna SALDO)

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

        // ── 1. Auto-detectar posiciones de columnas CARGOS / ABONOS ───
        //    Buscar la línea de encabezados de la tabla
        const lineTextFull = words.map(w => w.str).join(' ');
        if (/\bCARGOS\b/i.test(lineTextFull) && /\bABONOS\b/i.test(lineTextFull)) {
          const cItem    = words.find(w => /^CARGOS$/i.test(w.str));
          const aItem    = words.find(w => /^ABONOS$/i.test(w.str));
          // "OPERACIÓN" puede venir fragmentado por la Ó; buscamos el item que empieza con "OPERACI"
          const operItem = words.find(w => /^OPERACI/i.test(w.str));
          if (cItem && aItem) {
            xCargosCenter = cItem.x + (cItem.w || 0) / 2;
            xAbonosCenter = aItem.x + (aItem.w || 0) / 2;
          }
          if (operItem) xSaldoStart = operItem.x;
          continue;
        }

        // ── 2. Saltar cabeceras / pies de página ───────────────────────
        // Nota: NO incluir "BBVA" aquí porque puede aparecer en descripciones
        // de transacciones (ej. "COM SERV BBVA NET CAS").
        if (/Estado de Cuenta|PAGINA|No\.\s*(?:Cuenta|Cliente)|FECHA SALDO|CASH MANAGEMENT/i.test(lineTextFull)) {
          continue;
        }

        // ── 3. Separar ítems numéricos (montos) de texto ───────────────
        const amountItems = words.filter(w => AMOUNT_RE.test(w.str.replace(/\s/g, '')));
        const textItems   = words.filter(w => !AMOUNT_RE.test(w.str.replace(/\s/g, '')));
        const lineText    = textItems.map(w => w.str).join(' ').trim();

        // ── 4. Detectar si la línea inicia una transacción ─────────────
        const txMatch = TX_LINE_RE.exec(lineText);

        if (txMatch) {
          // Guardar tx anterior
          if (currentTx) this.transactions.push(currentTx);

          const [, fOper, fLiq, codigo, concepto] = txMatch;

          // Clasificar montos por posición X
          let montoCargo = '';
          let montoAbono = '';

          const xSaldoCutoff = xSaldoStart - 10;
          for (const ai of amountItems) {
            const cx = ai.x + (ai.w || 0) / 2;
            // Rechazar cualquier monto cuyo cx esté en la columna SALDO o más a la derecha
            if (cx >= xSaldoCutoff) continue;
            const dCargo = Math.abs(cx - xCargosCenter);
            const dAbono = Math.abs(cx - xAbonosCenter);
            if (dAbono < dCargo) {
              montoAbono = ai.str;
            } else {
              montoCargo = ai.str;
            }
          }

          currentTx = {
            'Fecha Operacion':   fOper,
            'Fecha Liquidacion': fLiq,
            'Codigo':            codigo,
            'Concepto':          concepto.trim(),
            'Descripcion':       '',
            'Referencia':        '',
            'Monto Abono':       montoAbono,
            'Monto Cargo':       montoCargo
          };

        } else if (currentTx) {
          // ── 5. Línea de continuación ────────────────────────────────
          // Ignorar líneas que solo contienen dígitos (CLABEs, referencias numéricas)
          const isOnlyDigits = textItems.every(w => /^\d+$/.test(w.str));
          if (isOnlyDigits && !amountItems.length) continue;

          const refMatch = /Ref\.\s*(\S+)/i.exec(lineText);
          if (refMatch) {
            currentTx['Referencia'] = refMatch[1];
            const clean = lineText.replace(/Ref\.\s*\S+/i, '').trim();
            if (clean) currentTx['Descripcion'] = (currentTx['Descripcion'] + ' ' + clean).trim();
          } else if (lineText) {
            currentTx['Descripcion'] = (currentTx['Descripcion'] + ' ' + lineText).trim();
          }
        }
      }

      await page.cleanup();
    }

    if (currentTx) this.transactions.push(currentTx);
    await doc.destroy();

    // Filtrar filas sin monto
    this.transactions = this.transactions.filter(
      tx => tx['Monto Cargo'] || tx['Monto Abono']
    );
  }
}

module.exports = { BBVAExtractor };
