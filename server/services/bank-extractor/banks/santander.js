'use strict';

const { BankExtractorBase } = require('../base');

// Elimina diacríticos y convierte a mayúsculas — equivalente al _normalize() de Python
function normalize(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

const AMOUNT_RE = /\b\d{1,3}(?:,\d{3})*\.[0-9oO]{1,2}\b/g;

function isAmountSeg(seg) {
  const s = seg.replace(/\s+/g, '');
  return /^[\d,]+\.[0-9oO]{1,2}$/.test(s);
}

// Normaliza montos OCR: elimina espacios y corrige 'oo' → '00'
function cleanAmount(seg) {
  let s = seg.replace(/\s+/g, '');
  s = s.replace(/(?<=\.)[oO]+/g, m => '0'.repeat(m.length));
  return s;
}

function toFloat(val) {
  if (!val) return 0;
  try {
    return parseFloat(cleanAmount(String(val)).replace(/,/g, ''));
  } catch {
    return 0;
  }
}

// Formatea un número float como cadena monetaria "1,234.56"
function formatAmount(n) {
  if (!n && n !== 0) return '';
  const fixed = Math.abs(n).toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${intFormatted}.${decPart}`;
}

class SantanderExtractor extends BankExtractorBase {
  constructor(pdfPath) {
    super(pdfPath);
    this.bankName = 'Santander';
  }

  async extractTransactions() {
    this.transactions = [];

    const datePattern = /(\d{2}-[A-Z]{3}-\d{4})/i;
    const folioPattern = /^(\d{4,10})\s+([\s\S]*)/;
    const folioOnlyPattern = /^(\d{4,10})$/;

    const keywordsAbono = [
      'ABONO', 'DEPOSITO', 'ABO ', 'RECIBIDO', 'TRASPASO A FAVOR',
      'INTERESES', 'PAGO ANTICIPADO', 'DEV', 'DISPOSICION DE CREDITO',
      'DISPOSICION CREDITO', 'BONI', 'BONIFICACION',
      'REEMBOLSO',           // devolución/reembolso de comisiones → abono
      'COMPENSACION SPEI',   // ajuste de centavos vía SPEI → abono
      'IVA POR COMISION MEM' // IVA del reembolso de membresía → abono
    ];
    const keywordsRetiro = ['RETENCION', 'COBRO', 'CARGO', 'PAGO', 'RET ', 'CARGO CAPITAL'];

    // Líneas de saldo/resumen que NO son transacciones reales — se deben omitir
    const skipConceptPatterns = [
      /SALDO.*PERIODO ANTERIOR/i,
      /SALDO INICIAL/i,
      /SALDO FINAL DEL PERIODO/i,
      /SALDO AL \d/i,
      /SALDO PROMEDIO/i,
      /TOTAL DE MOVIMIENTOS/i,
      /RESUMEN (DE|DEL)/i,
    ];

    try {
      let currentTx = null;

      for await (const text of this.iteratePages()) {
        if (!text) continue;

        for (const line of text.split('\n')) {
          const lineNorm = normalize(line);
          if (lineNorm.includes('ESTADO DE CUENTA') || lineNorm.includes('PAGINA')) continue;

          // Separar columnas por 2+ espacios (mismo criterio que Python)
          const segments = line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
          if (!segments.length) continue;

          const dateMatch = datePattern.exec(segments[0]);

          if (dateMatch) {
            if (currentTx) this.transactions.push(currentTx);

            const fecha = dateMatch[1];
            const foundAmounts = [];
            const conceptParts = [];
            let folio = '';

            const firstRem = segments[0].slice(dateMatch.index + dateMatch[0].length).trim();

            if (segments.length > 1) {
              // Formato OCR: columnas separadas por espacios múltiples
              if (firstRem) {
                const fm = folioPattern.exec(firstRem);
                if (fm) {
                  folio = fm[1];
                  const desc = fm[2].trim();
                  if (desc) conceptParts.push(desc);
                } else if (folioOnlyPattern.test(firstRem)) {
                  folio = firstRem;
                } else {
                  conceptParts.push(firstRem);
                }
              }
              for (const seg of segments.slice(1)) {
                if (isAmountSeg(seg)) {
                  foundAmounts.push(seg);
                } else {
                  // El segmento puede contener dos montos separados por un espacio simple
                  // (ocurre cuando RETIRO/DEPOSITO y SALDO tienen gap < 15pt en el PDF)
                  // Ej: "14,100.00 448,434.40" → dos montos sin separador de columna
                  const amtRe = /\b\d{1,3}(?:,\d{3})*\.[0-9oO]{1,2}\b/g;
                  const parts = [...seg.matchAll(amtRe)].map(m => m[0]);
                  const textRem = seg.replace(amtRe, '').trim();
                  if (parts.length > 0 && !textRem) {
                    foundAmounts.push(...parts);
                  } else {
                    conceptParts.push(seg);
                  }
                }
              }
            } else {
              // Formato digital: todo en un segmento, montos pegados al final
              const amtMatches = [...firstRem.matchAll(new RegExp(AMOUNT_RE.source, 'g'))];
              if (amtMatches.length) {
                const descText = firstRem.slice(0, amtMatches[0].index).trim();
                for (const m of amtMatches) foundAmounts.push(m[0]);
                const fm = /^(\d{4,10})\s*(.*)/.exec(descText);
                if (fm) {
                  folio = fm[1];
                  if (fm[2].trim()) conceptParts.push(fm[2].trim());
                } else if (descText) {
                  conceptParts.push(descText);
                }
              } else {
                const fm = /^(\d{4,10})\s*(.*)/.exec(firstRem);
                if (fm) {
                  folio = fm[1];
                  if (fm[2].trim()) conceptParts.push(fm[2].trim());
                } else if (firstRem) {
                  conceptParts.push(firstRem);
                }
              }
            }

            const concepto = conceptParts.join(' ');

            // Filtrar encabezados de tabla
            if (concepto.toUpperCase().includes('FECHA') && concepto.toUpperCase().includes('SALDO')) {
              currentTx = null;
              continue;
            }

            // Filtrar líneas de saldo/resumen que no son transacciones reales
            if (skipConceptPatterns.some(p => p.test(concepto))) {
              currentTx = null;
              continue;
            }

            let montoRetiro = '';
            let montoDeposito = '';
            let saldo = '';

            const conceptUpper = concepto.toUpperCase();

            // Señales fuertes al INICIO del concepto (más confiables que contains)
            const inicioAbono  = /^(ABO |ABONO|DEP |DEPOSITO|RECIB|DEV |DEVOL|TRASPASO A FAVOR|BONI|DISPOSICION)/i.test(concepto.trim());
            const inicioRetiro = /^(CARGO|RET |RETIRO|RETENC|COBRO|PAGO )/i.test(concepto.trim());

            // Si el inicio es claro → usarlo; si no → caer en keywords generales
            const esAbono  = inicioAbono  || (!inicioRetiro && keywordsAbono.some(kw => conceptUpper.includes(kw)));
            const esRetiro = inicioRetiro || (!esAbono       && keywordsRetiro.some(kw => conceptUpper.includes(kw)));

            if (foundAmounts.length >= 3) {
              const v0 = toFloat(foundAmounts[0]);
              const v1 = toFloat(foundAmounts[1]);
              if (v1 > 0 && v0 === 0) {
                montoDeposito = cleanAmount(foundAmounts[1]);
              } else if (v0 > 0 && v1 === 0) {
                montoRetiro = cleanAmount(foundAmounts[0]);
              } else {
                if (esAbono && !esRetiro) montoDeposito = cleanAmount(foundAmounts[1]);
                else montoRetiro = cleanAmount(foundAmounts[0]);
              }
              saldo = cleanAmount(foundAmounts[foundAmounts.length - 1]);
            } else if (foundAmounts.length === 2) {
              const val = cleanAmount(foundAmounts[0]);
              if (esAbono && !esRetiro) montoDeposito = val;
              else montoRetiro = val;
              saldo = cleanAmount(foundAmounts[1]);
            } else if (foundAmounts.length === 1) {
              const val = cleanAmount(foundAmounts[0]);
              if (esAbono && !esRetiro) montoDeposito = val;
              else montoRetiro = val;
            }

            currentTx = {
              'FECHA': fecha,
              'REFERENCIA': folio,
              'CONCEPTO': concepto,
              'MONTO DEPOSITOS': montoDeposito,
              'MONTO RETIROS': montoRetiro,
              'SALDO': saldo
            };

          } else {
            // Línea de continuación del concepto
            const skipKw = ['FECHA', 'FOLIO', 'SALDO', 'PAGINA', 'P-P', 'CODIGO DE CLIENTE', 'GRUPO FINANCIERO'];
            // Saltar líneas de resumen TOTAL al final de la sección de movimientos
            const isTotalSummary = /^\s*TOTAL\s+[\d,]+\.\d{2}/i.test(line);
            if (currentTx && !isTotalSummary && !skipKw.some(kw => lineNorm.includes(kw))) {
              currentTx['CONCEPTO'] += ' ' + line.trim();
            }
          }
        }
      }

      if (currentTx) this.transactions.push(currentTx);

      // Filtrar filas sin monto (encabezados que se colaron)
      this.transactions = this.transactions.filter(
        tx => tx['MONTO RETIROS'] || tx['MONTO DEPOSITOS']
      );

      // Para PDFs escaneados: corregir montos que OCR confundió con el saldo
      if (this.usedOcr && this.transactions.length > 0) {
        this.transactions = this._correctOcrAmounts(this.transactions);
      }

    } catch (err) {
      console.error(`Error procesando Santander ${this.pdfPath}:`, err.message);
    }

    return this.transactions;
  }

  /**
   * Corrección específica para PDFs escaneados (OCR):
   *
   * Patrón detectado: OCR lee la columna SALDO como si fuera el MONTO de la
   * transacción. Esto ocurre cuando la separación de columnas se colapsa y
   * el número del saldo queda en la posición del monto. El resultado:
   *   - La transacción tiene un monto imposiblemente grande (millones)
   *   - La columna SALDO queda vacía
   *   - El CONCEPTO contiene el monto real al final (p.ej. "PAGO DE NOMINA 3732.54")
   *
   * Corrección: si monto_capturado / monto_concepto > 100 → usar el del concepto.
   *
   * Solo se aplica cuando usedOcr === true.
   */
  _correctOcrAmounts(transactions) {
    // Extrae el último número decimal al final del concepto
    // Acepta tanto "3732.54" (sin coma — típico de OCR) como "3,732.54"
    const TRAIL_NUM = /\b(\d[\d,]*\.\d{2})\s*$/;

    let corrections = 0;
    const corrected = transactions.map(tx => {
      const retiro   = toFloat(tx['MONTO RETIROS']);
      const deposito = toFloat(tx['MONTO DEPOSITOS']);
      const captured = Math.max(retiro, deposito);

      // Solo aplicar si el monto es grande (> 1 millón) y no hay saldo registrado
      if (captured < 1_000_000 || tx['SALDO']) return tx;

      const concepto = String(tx['CONCEPTO'] || '');
      const match = TRAIL_NUM.exec(concepto);
      if (!match) return tx;

      const conceptoAmt = toFloat(match[1]);
      if (conceptoAmt <= 0) return tx;

      // Solo corregir si el ratio es extremo (> 100×)
      const ratio = captured / conceptoAmt;
      if (ratio < 100) return tx;

      console.log(`  [OCR-fix] tx ${tx['FECHA']} "${concepto.slice(0, 50)}" → monto ${captured.toFixed(2)} → ${conceptoAmt.toFixed(2)} (ratio ${ratio.toFixed(0)}×)`);
      corrections++;

      return {
        ...tx,
        'MONTO RETIROS':   retiro   > 0 ? formatAmount(conceptoAmt) : tx['MONTO RETIROS'],
        'MONTO DEPOSITOS': deposito > 0 ? formatAmount(conceptoAmt) : tx['MONTO DEPOSITOS'],
      };
    });

    if (corrections > 0) {
      console.log(`  [OCR-fix] ${corrections} monto(s) corregido(s) por concepto.`);
    }

    return corrected;
  }
}

module.exports = { SantanderExtractor };
