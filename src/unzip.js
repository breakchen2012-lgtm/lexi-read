/* 极简 ZIP 读取器 —— EPUB / DOCX 本质都是 ZIP。
   只依赖浏览器内置的 DecompressionStream('deflate-raw')，不引入任何第三方库。 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const utf8 = new TextDecoder('utf-8');

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压（需要 Safari 16.4+ / iOS 16.4+ / Chrome 80+）');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{names:()=>string[], has:(n:string)=>boolean,
 *                    read:(n:string)=>Promise<Uint8Array|null>,
 *                    text:(n:string)=>Promise<string|null>}>}
 */
export async function unzip(buffer) {
  const u8 = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (u8.length < 22) throw new Error('文件太小，不是有效的压缩包');

  // 从尾部往前找中央目录结束记录（可能带最多 64KB 注释）
  let eocd = -1;
  const floor = Math.max(0, u8.length - 66000);
  for (let i = u8.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP / EPUB / DOCX 文件');

  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  if (count === 0xffff || off === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的超大压缩包');
  }
  if (off + 46 * count > u8.length) throw new Error('压缩包目录损坏');

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > u8.length || view.getUint32(off, true) !== CD_SIG) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const rawSize = view.getUint32(off + 24, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const cmtLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    if (compSize === 0xffffffff || rawSize === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式的超大压缩包');
    }
    const name = utf8.decode(u8.subarray(off + 46, off + 46 + nameLen));
    if (!name.endsWith('/')) entries.set(name, { name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  if (!entries.size) throw new Error('压缩包里没有文件');

  const api = {
    names: () => [...entries.keys()],
    has: n => entries.has(n),
    find: re => [...entries.keys()].find(n => re.test(n)) || null,

    async read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (view.getUint32(e.localOff, true) !== LOCAL_SIG) throw new Error('压缩包局部头损坏：' + name);
      const nLen = view.getUint16(e.localOff + 26, true);
      const eLen = view.getUint16(e.localOff + 28, true);
      const start = e.localOff + 30 + nLen + eLen;
      const data = u8.subarray(start, start + e.compSize);
      if (e.method === 0) return data.slice();
      if (e.method !== 8) throw new Error(`不支持的压缩方式（method=${e.method}）：${name}`);
      return inflateRaw(data);
    },

    async text(name) {
      const d = await api.read(name);
      return d ? utf8.decode(d) : null;
    },
  };
  return api;
}
