const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

const read = (name) => readFileSync(join(__dirname, '../../js', name), 'utf8');

// 立面公共参数是纯 JS；节点模块只需要一个 three/tsl 命名空间，几何测试可以传空桩。
function loadFacadeLook() {
  return loadModule(read('sz-facade-look.js'), { filename: 'sz-facade-look.js' });
}

function loadFacadeNodes(tsl = {}) {
  // 哈希用 Fn 包成可复用函数节点（保持冷编译节点数）；纯几何测试没有 TSL 时给一个惰性替身。
  const namespace = tsl.Fn ? tsl : { ...tsl, Fn: fn => (...args) => fn(args) };
  return loadModule(read('sz-facade-nodes.js'), {
    imports: { 'three/tsl': namespace, './sz-facade-look.js': loadFacadeLook() },
    filename: 'sz-facade-nodes.js'
  });
}

module.exports = { loadFacadeLook, loadFacadeNodes };
