#!/usr/bin/env node
'use strict';

const { main } = require('../skills/selection-bridge/scripts/resolve-selection-bridge.js');

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, error: { code: 'unexpected_error', message } }, null, 2));
    process.exitCode = 1;
  });
