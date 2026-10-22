import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBrowser } from "../apps/fnos-nas-agent/app/file-browser.mjs";
import { parseImageMetadata } from "../apps/fnos-nas-agent/app/photo-metadata.mjs";

function makeExifJpeg() {
  const tiff = Buffer.alloc(180);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);

  tiff.writeUInt16LE(3, 8);
  // IFD0: camera make
  tiff.writeUInt16LE(0x010f, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(6, 14);
  tiff.writeUInt32LE(50, 18);
  // EXIF IFD offset
  tiff.writeUInt16LE(0x8769, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(56, 30);
  // GPS IFD offset
  tiff.writeUInt16LE(0x8825, 34);
  tiff.writeUInt16LE(4, 36);
  tiff.writeUInt32LE(1, 38);
  tiff.writeUInt32LE(96, 42);
  tiff.write("Canon\0", 50, "ascii");

  tiff.writeUInt16LE(1, 56);
  tiff.writeUInt16LE(0x9003, 58);
  tiff.writeUInt16LE(2, 60);
  tiff.writeUInt32LE(20, 62);
  tiff.writeUInt32LE(74, 66);
  tiff.write("2024:07:21 10:11:12\0", 74, "ascii");

  tiff.writeUInt16LE(2, 96);
  tiff.writeUInt16LE(0x0002, 98);
  tiff.writeUInt16LE(5, 100);
  tiff.writeUInt32LE(3, 102);
  tiff.writeUInt32LE(130, 106);
  tiff.writeUInt16LE(0x0004, 110);
  tiff.writeUInt16LE(5, 112);
  tiff.writeUInt32LE(3, 114);
  tiff.writeUInt32LE(154, 118);

  for (const offset of [130, 138, 146, 154, 162, 170]) {
    tiff.writeUInt32LE(offset % 20 + 1, offset);
    tiff.writeUInt32LE(1, offset + 4);
  }

  const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const app1 = Buffer.alloc(4 + exifPayload.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  app1.writeUInt16BE(exifPayload.length + 2, 2);
  exifPayload.copy(app1, 4);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}

function makePng(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test("JPEG metadata parser reads camera, capture timestamp, dimensions and GPS presence but not GPS coordinates", () => {
  const metadata = parseImageMetadata(makeExifJpeg(), "holiday.jpg");
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 64);
  assert.equal(metadata.height, 32);
  assert.equal(metadata.camera, "Canon");
  assert.equal(metadata.dateTaken, "2024-07-21 10:11:12");
  assert.equal(metadata.hasGps, true);
  assert.equal("latitude" in metadata, false);
  assert.equal("longitude" in metadata, false);
});

test("PNG metadata parser reads dimensions from a bounded header", () => {
  const metadata = parseImageMetadata(makePng(1920, 1080), "Screenshot.png");
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 1920);
  assert.equal(metadata.height, 1080);
  assert.equal(metadata.metadataAvailable, true);
});

// searchPhotos 走 file-browser 的 Linux 描述符路径（O_NOFOLLOW 语义），
// Windows 上没有等价物，和 phase-133 一样只在 Linux 上跑这条端到端用例。
test("local photo search supports EXIF dates, camera names, categories and GPS-presence filters without leaving allowed roots", { skip: process.platform !== "linux" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "fnos-photo-gallery-"));
  try {
    const root = join(temp, "vol1");
    const dcim = join(root, "DCIM");
    const screenshots = join(root, "Screenshots");
    const scans = join(root, "Scans");
    const secrets = join(root, "secrets");
    const outside = join(temp, "outside");
    // 先把 root 建好，再并行建子目录：否则 mkdir(screenshots) 会和
    // mkdir(dcim, { recursive: true }) 抢跑，在 Linux 上报 ENOENT。
    await mkdir(root, { recursive: true });
    await Promise.all([mkdir(dcim, { recursive: true }), mkdir(screenshots), mkdir(scans), mkdir(secrets), mkdir(outside)]);
    await writeFile(join(dcim, "holiday.jpg"), makeExifJpeg());
    await writeFile(join(screenshots, "Screenshot_2025.png"), makePng(800, 600));
    await writeFile(join(scans, "id-scan.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await writeFile(join(secrets, "private.jpg"), makeExifJpeg());
    await writeFile(join(outside, "external.jpg"), makeExifJpeg());
    // Windows 未开开发者模式时建不了符号链接；建不了就跳过「链接不跟随」断言，
    // 其余断言照跑，不让环境能力把整条用例拖红。
    let symlinked = true;
    try {
      await symlink(join(outside, "external.jpg"), join(dcim, "outside-link.jpg"));
    } catch {
      symlinked = false;
    }
    const date = new Date("2025-03-12T12:00:00.000Z");
    await utimes(join(screenshots, "Screenshot_2025.png"), date, date);

    const browser = createFileBrowser({ roots: [root] });
    const camera = await browser.searchPhotos({ query: "Canon", limit: 10 });
    assert.equal(camera.count, 1);
    assert.equal(camera.photos[0].name, "holiday.jpg");
    assert.equal(camera.photos[0].dateTaken, "2024-07-21 10:11:12");
    assert.equal(camera.photos[0].camera, "Canon");
    assert.equal(camera.photos[0].hasGps, true);
    assert.equal("latitude" in camera.photos[0], false);
    assert.equal("longitude" in camera.photos[0], false);

    const year = await browser.searchPhotos({ dateFrom: "2024-01-01", dateTo: "2024-12-31", limit: 10 });
    assert.deepEqual(year.photos.map(photo => photo.name), ["holiday.jpg"]);
    const imageDateFallback = await browser.searchPhotos({ dateFrom: "2025-01-01", dateTo: "2025-12-31", category: "screenshot" });
    assert.equal(imageDateFallback.photos[0].name, "Screenshot_2025.png");
    assert.equal(imageDateFallback.photos[0].dateSource, "modified");
    assert.equal(imageDateFallback.photos[0].width, 800);
    assert.equal(imageDateFallback.photos[0].height, 600);

    const screenshotsFound = await browser.searchPhotos({ category: "screenshot" });
    assert.equal(screenshotsFound.count, 1);
    const scansFound = await browser.searchPhotos({ category: "scan" });
    assert.equal(scansFound.count, 1);
    const gpsFound = await browser.searchPhotos({ hasGps: true });
    assert.deepEqual(gpsFound.photos.map(photo => photo.name), ["holiday.jpg"]);

    const serialized = JSON.stringify(camera);
    if (symlinked) {
      assert.ok(!serialized.includes("outside-link.jpg"));
      assert.ok(!serialized.includes("external.jpg"));
    }
    assert.ok(!serialized.includes("private.jpg"));
    assert.ok(!serialized.includes("latitude"));
    assert.ok(!serialized.includes("longitude"));
    await assert.rejects(browser.searchPhotos({ path: outside, query: "external" }), error => error.statusCode === 403 || error.statusCode === 404);
    await assert.rejects(browser.searchPhotos({ dateFrom: "2025-02-31" }), { statusCode: 400 });
    await assert.rejects(browser.searchPhotos({ category: "shell" }), { statusCode: 400 });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
