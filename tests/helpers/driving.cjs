const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

module.exports = Object.fromEntries(['sz-driving-motion.js', 'vehicle-physics.js', 'sz-flight-motion.js'].map(name =>
  ['./' + name, loadModule(readFileSync(join(__dirname, '../../js', name), 'utf8'))]));
