// 构建时复用运行时校验与坐标解码，避免离线包绕过浏览器的数据契约。
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../js/sz-data-format.js', import.meta.url), 'utf8');
const { decodeCityPayload } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
decodeCityPayload(JSON.parse(Buffer.concat(chunks).toString('utf8')));
console.log('City payload validation passed');
