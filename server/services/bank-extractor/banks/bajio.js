'use strict';

const { BankExtractorBase } = require('../base');

class BajioExtractor extends BankExtractorBase {
  constructor(pdfPath, logger, pageTexts) {
    super(pdfPath, logger, pageTexts);
    this.bankName = 'Bajio';
  }

  async extractTransactions() {
    this.transactions = [];

    // Fecha: "25 ENE" o "5 ENE"
    const datePattern = /^\s*(\d{1,2}\s+[A-Z]{3})/;

    try {
      let currentTx = null;

      for await (const text of this.iteratePages()) {
        if (!text) continue;

        for (const line of text.split('\n')) {
          if (/ESTADO DE CUENTA|SALDO TOTAL|^FECHA/i.test(line)) continue;

          const dateMatch = datePattern.exec(line);
          if (dateMatch) {
            if (currentTx) this.transactions.push(currentTx);

            const fecha = dateMatch[1];
            const resto = line.slice(dateMatch.index + dateMatch[0].length).trim();

            // Montos con prefijo "$"
            const montos = [...resto.matchAll(/\$\s*([\d,]+\.\d{2})/g)].map(m => m[1]);

            let ref = '';
            let desc = resto;
            const refMatch = /^(\d+)/.exec(resto);
            if (refMatch) {
              ref = refMatch[1];
              desc = resto.slice(ref.length).trim();
            }

            const concepto = desc.replace(/\$\s*[\d,]+\.\d{2}/g, '').trim();
            const saldo = montos.length ? montos[montos.length - 1] : '';
            let deposito = '';
            let retiro = '';

            if (montos.length >= 2) {
              const esDeposito = /DEP|ABONO/i.test(concepto);
              if (esDeposito) deposito = montos[0];
              else retiro = montos[0];
            }

            currentTx = {
              'Fecha': fecha,
              'NO. REF. / DOCTO': ref,
              'DESCRIPCION DE LA OPERACION': concepto,
              'Monto DEPOSITOS': deposito,
              'Monto RETIROS': retiro,
              'SALDO': saldo
            };
          } else if (currentTx) {
            currentTx['DESCRIPCION DE LA OPERACION'] =
              (currentTx['DESCRIPCION DE LA OPERACION'] + ' ' + line).trim();
          }
        }
      }

      if (currentTx) this.transactions.push(currentTx);

    } catch (err) {
      console.error(`Error procesando Bajio ${this.pdfPath}:`, err.message);
    }

    return this.transactions;
  }
}

module.exports = { BajioExtractor };
