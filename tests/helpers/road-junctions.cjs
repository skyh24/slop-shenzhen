const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');
const read = name => readFileSync(join(__dirname, '../../js', name), 'utf8');
module.exports = loadModule(read('sz-road-junctions.js'), { imports: {
  './sz-roads.js': require('./roads.cjs'),
  './sz-section-frame.js': require('./section-frame.cjs'),
  './sz-ground-surface.js': loadModule(read('sz-ground-surface.js')),
  './sz-road-section.js': loadModule(read('sz-road-section.js')),
  './sz-interchange-levels.js': loadModule(read('sz-interchange-levels.js')),
  './sz-terrain.js': loadModule(read('sz-terrain.js'))
} });
