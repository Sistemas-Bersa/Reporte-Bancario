'use strict';

const { BBVAExtractor }      = require('./bbva');
const { SantanderExtractor } = require('./santander');
const { BanamexExtractor }   = require('./banamex');
const { BajioExtractor }     = require('./bajio');
const { BanorteExtractor }   = require('./banorte');

module.exports = {
  BBVAExtractor,
  SantanderExtractor,
  BanamexExtractor,
  BajioExtractor,
  BanorteExtractor
};
