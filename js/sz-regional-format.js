export const REGIONAL_SCENE_VERSION = 2;
export const REGIONAL_SCENE_DIRECTORY = 'sz-regional';
export const REGIONAL_SCENE_MAX_BYTES = 1000000;

export function compatibleRegionalScene(scene) {
  return scene?.version === REGIONAL_SCENE_VERSION && /^[a-f0-9]{64}$/.test(scene.fingerprint)
    && Array.isArray(scene.cells) && Array.isArray(scene.drone?.stations) && Array.isArray(scene.drone?.routes)
    && scene.packs && Object.values(scene.packs).every(pack => Number.isInteger(pack.bytes) && pack.bytes > 0)
    && Object.values(scene.packs).reduce((bytes, pack) => bytes + pack.bytes, 0) <= REGIONAL_SCENE_MAX_BYTES
    && scene.cells.every(row => Object.hasOwn(scene.packs, row.pack));
}

// 三个资源共用请求缓存，区域离开只释放实例。各块仍按原有队列解析和挂载。
export function createRegionalPackLoader(manifest, request = fetch) {
  const pending = new Map();
  const abort = new AbortController();
  async function load(name) {
    const url = new URL(`./${REGIONAL_SCENE_DIRECTORY}/${manifest.fingerprint.slice(0, 20)}/${name}.json.gz`, import.meta.url);
    const response = await request(url, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(6000)]) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (compressed && bytes.length !== manifest.packs[name].bytes) throw new Error('Regional pack size mismatch');
    const stream = new Blob([bytes]).stream();
    const raw = await new Response(compressed ? stream.pipeThrough(new DecompressionStream('gzip')) : stream).text();
    if (raw.length > 16 * 1024 * 1024) throw new Error('Regional pack exceeds the size limit');
    const pack = JSON.parse(raw);
    if (pack.version !== REGIONAL_SCENE_VERSION || pack.fingerprint !== manifest.fingerprint || !pack.data) {
      throw new Error('Regional pack version or input fingerprint mismatch');
    }
    return pack.data;
  }
  return {
    async read(row) {
      if (!pending.has(row.pack)) {
        const work = load(row.pack);
        pending.set(row.pack, work);
        work.catch(() => { if (pending.get(row.pack) === work) pending.delete(row.pack); });
      }
      const data = await pending.get(row.pack);
      if (!Object.hasOwn(data, row.id) || data[row.id] == null) throw new Error(`Missing regional cell: ${row.id}`);
      // 挂载会展开紧凑字段，缓存保留原始数据供再次进入时使用。
      return structuredClone(data[row.id]);
    },
    dispose() { abort.abort(); pending.clear(); }
  };
}
