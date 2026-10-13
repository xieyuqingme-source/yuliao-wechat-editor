// Generate small deterministic PNG fixtures without private files or network access.
// Run only to recreate the images committed under samples/vault.
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vault');
const crcTable = Array.from({length:256}, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, bytes) => {
  const name = Buffer.from(type);
  const output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length,0);
  name.copy(output,4);
  bytes.copy(output,8);
  output.writeUInt32BE(crc32(Buffer.concat([name,bytes])),bytes.length + 8);
  return output;
};
function png(width, height, palette) {
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nearBorder = x < 12 || y < 12 || x >= width - 12 || y >= height - 12;
      const circle = (x - width * .72) ** 2 + (y - height * .35) ** 2 < (height * .16) ** 2;
      const stripe = y > height * .62 && x > width * .12 && x < width * .88;
      const color = palette[nearBorder ? 0 : circle ? 2 : stripe ? 3 : 1];
      const offset = y * stride + 1 + x * 3;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = color[channel];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width,0);
  header.writeUInt32BE(height,4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
const teal = [[27,89,87],[221,242,232],[255,206,128],[64,133,123]];
const orange = [[143,75,48],[255,236,218],[231,128,80],[205,152,112]];
const blue = [[41,74,108],[222,235,247],[137,176,216],[97,132,172]];
const images = [
  ['文章/同位 图片.png',400,240,teal],
  ['附件/中文 空格图片.png',640,360,orange],
  ['附件/标准 图.png',400,240,blue],
  ['附件/宽图.png',720,300,teal],
  ['附件/同名.png',400,240,teal],
  ['其他/同名.png',400,240,orange],
];
for (const [relative,width,height,palette] of images) {
  const target = path.join(root,...relative.split('/'));
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,png(width,height,palette));
}
console.log(`已生成 ${images.length} 张合成 PNG：${root}`);
