const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

module.exports = loadModule(readFileSync(join(__dirname, '../../js/sz-roads.js'), 'utf8'), {
  imports: { 'three/webgpu': {}, './sz-road-material.js': {} }
});
