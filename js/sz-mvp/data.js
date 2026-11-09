// 读取 tools/sz/build.py 生成的 sz-mvp.json.gz，并把差分编码的分米坐标还原成米
const DATA_URL = new URL('./data/sz-mvp.json.gz', import.meta.url);

async function readJsonGz(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // 服务器可能已经自动解压，看 gzip 魔数再决定
  const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = gz
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

export function decodeRing(flat) {
  const out = new Float32Array(flat.length);
  let x = 0;
  let z = 0;
  for (let i = 0; i < flat.length; i += 2) {
    x += flat[i];
    z += flat[i + 1];
    out[i] = x / 10;
    out[i + 1] = z / 10;
  }
  return out;
}

export function decodePoly(rings) {
  return rings.map(decodeRing);
}

export async function loadCityData() {
  const raw = await readJsonGz(DATA_URL);
  if (raw.version !== 1) throw new Error(`Unsupported sz-mvp data version ${raw.version}`);
  return raw;
}
