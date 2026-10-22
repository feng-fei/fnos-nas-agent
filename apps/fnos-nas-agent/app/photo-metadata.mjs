const JPEG = "jpeg";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function u16(buffer, offset, little) {
  if (offset < 0 || offset + 2 > buffer.length) return null;
  return little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}
function u32(buffer, offset, little) {
  if (offset < 0 || offset + 4 > buffer.length) return null;
  return little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}
function ascii(buffer, offset, count) {
  if (!Number.isInteger(offset) || !Number.isInteger(count) || offset < 0 || count < 0 || offset + count > buffer.length) return "";
  return buffer.toString("ascii", offset, offset + count).replace(/\0+$/, "").trim();
}
function parseTiff(buffer, tiffStart) {
  if (tiffStart < 0 || tiffStart + 8 > buffer.length) return {};
  const order = buffer.toString("ascii", tiffStart, tiffStart + 2);
  const little = order === "II";
  if (!little && order !== "MM") return {};
  if (u16(buffer, tiffStart + 2, little) !== 42) return {};

  function entriesAt(relativeOffset) {
    const offset = tiffStart + relativeOffset;
    const count = u16(buffer, offset, little);
    if (count === null || count > 256 || offset + 2 + count * 12 > buffer.length) return [];
    const entries = [];
    for (let index = 0; index < count; index++) {
      const entryOffset = offset + 2 + index * 12;
      const tag = u16(buffer, entryOffset, little);
      const type = u16(buffer, entryOffset + 2, little);
      const valueCount = u32(buffer, entryOffset + 4, little);
      const unitSize = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 })[type];
      if (tag === null || !unitSize || valueCount === null || valueCount > 4096) continue;
      const byteLength = valueCount * unitSize;
      const valueOffset = byteLength <= 4 ? entryOffset + 8 : tiffStart + (u32(buffer, entryOffset + 8, little) ?? buffer.length + 1);
      if (valueOffset < 0 || valueOffset + byteLength > buffer.length) continue;
      entries.push({ tag, type, count: valueCount, offset: valueOffset });
    }
    return entries;
  }
  const rootOffset = u32(buffer, tiffStart + 4, little);
  if (rootOffset === null) return {};
  const rootEntries = entriesAt(rootOffset);
  const find = (entries, tag) => entries.find(entry => entry.tag === tag);
  const readAscii = entry => entry && entry.type === 2 ? ascii(buffer, entry.offset, Math.min(entry.count, 256)) : "";
  const cameraParts = [readAscii(find(rootEntries, 0x010f)), readAscii(find(rootEntries, 0x0110))].filter(Boolean);
  let dateTaken = "";
  let hasGps = false;
  const exifPtr = find(rootEntries, 0x8769);
  if (exifPtr && (exifPtr.type === 4 || exifPtr.type === 3)) {
    const exifOffset = exifPtr.type === 3 ? u16(buffer, exifPtr.offset, little) : u32(buffer, exifPtr.offset, little);
    if (Number.isInteger(exifOffset)) {
      const exifEntries = entriesAt(exifOffset);
      const original = find(exifEntries, 0x9003) || find(exifEntries, 0x9004);
      dateTaken = readAscii(original);
    }
  }
  const gpsPtr = find(rootEntries, 0x8825);
  if (gpsPtr && (gpsPtr.type === 4 || gpsPtr.type === 3)) {
    const gpsOffset = gpsPtr.type === 3 ? u16(buffer, gpsPtr.offset, little) : u32(buffer, gpsPtr.offset, little);
    if (Number.isInteger(gpsOffset)) {
      const gpsEntries = entriesAt(gpsOffset);
      hasGps = Boolean(find(gpsEntries, 0x0002) && find(gpsEntries, 0x0004));
    }
  }
  return {
    camera: cameraParts.join(" ").slice(0, 120),
    dateTaken: /^\d{4}:\d{2}:\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(dateTaken)
      ? dateTaken.replace(/^([0-9]{4}):([0-9]{2}):([0-9]{2})/, "$1-$2-$3")
      : "",
    hasGps
  };
}
function parseJpeg(buffer) {
  const result = { format: JPEG, width: null, height: null, camera: "", dateTaken: "", hasGps: false };
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return result;
  let offset = 2;
  let segments = 0;
  while (offset + 4 <= buffer.length && segments++ < 256) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const dataStart = offset + 2;
    const dataEnd = offset + length;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && dataStart + 5 <= dataEnd) {
      result.height = buffer.readUInt16BE(dataStart + 1);
      result.width = buffer.readUInt16BE(dataStart + 3);
    }
    if (marker === 0xe1 && dataStart + 6 <= dataEnd &&
        buffer.toString("ascii", dataStart, dataStart + 6) === "Exif\0\0") {
      const exif = parseTiff(buffer, dataStart + 6);
      result.camera = exif.camera || result.camera;
      result.dateTaken = exif.dateTaken || result.dateTaken;
      result.hasGps = result.hasGps || Boolean(exif.hasGps);
    }
    offset += length;
  }
  return result;
}

export function classifyPhoto(name, path, metadata = {}) {
  const label = (String(path || "") + " " + String(name || "")).toLocaleLowerCase();
  if (/(?:screenshot|screen-shot|screen_shot|截屏|截图|螢幕截圖)/i.test(label)) return "screenshot";
  if (/(?:scan(?:ned)?|document|passport|identity|证件|扫描件|扫描)/i.test(label)) return "scan";
  if (metadata.dateTaken || metadata.camera || /(?:^|[\\/])dcim(?:[\\/]|$)|(?:照片|相片|photo|camera)/i.test(label)) return "photo";
  return "other";
}

export function parseImageMetadata(buffer, name = "") {
  const ext = String(name).toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
  if (!Buffer.isBuffer(buffer)) return { format: ext || "unknown", width: null, height: null, camera: "", dateTaken: "", hasGps: false, metadataAvailable: false };
  if (ext === "jpg" || ext === "jpeg" || (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8))
    return { ...parseJpeg(buffer), metadataAvailable: true };
  if (ext === "png" && buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE) && buffer.toString("ascii", 12, 16) === "IHDR") {
    return { format: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), camera: "", dateTaken: "", hasGps: false, metadataAvailable: true };
  }
  if (ext === "gif" && buffer.length >= 10 && (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a"))
    return { format: "gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), camera: "", dateTaken: "", hasGps: false, metadataAvailable: true };
  if (ext === "webp" && buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const result = { format: "webp", width: null, height: null, camera: "", dateTaken: "", hasGps: false, metadataAvailable: true };
    if (buffer.toString("ascii", 12, 16) === "VP8X") {
      result.width = 1 + buffer.readUIntLE(24, 3);
      result.height = 1 + buffer.readUIntLE(27, 3);
    }
    return result;
  }
  return { format: ext || "unknown", width: null, height: null, camera: "", dateTaken: "", hasGps: false, metadataAvailable: false };
}
