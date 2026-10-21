import { readdir, lstat, realpath, mkdir, open, link, unlink, rename, rmdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024, MAX_PREVIEW_BYTES = 1024 * 1024, MAX_TEXT_CREATE_BYTES = 1024 * 1024;
export const MAX_CHECKSUM_BYTES = 256 * 1024 * 1024;
const CHECKSUM_CHUNK_BYTES = 1024 * 1024;
function within(root,target){const rel=relative(root,target);return rel===""||(!rel.startsWith(".."+sep)&&rel!==".."&&!isAbsolute(rel));}
function fail(statusCode,message){throw Object.assign(new Error(message),{statusCode});}
function safeName(name){if(typeof name!=="string"||!name.trim()||name.length>255||name==="."||name===".."||/[\\/\0]/.test(name)||name.trim()!==name||/[\x00-\x1f\x7f]/.test(name))fail(400,"Invalid file name");return name;}
export function createFileManager({roots:suppliedRoots,env=process.env,fs={readdir,lstat,realpath,mkdir,open,link,unlink,rename,rmdir,readFile}}={}){
 async function getRoots(){let candidates=suppliedRoots;if(!Array.isArray(candidates)){const configured=typeof env.AGENT_FILE_ROOTS==="string"?env.AGENT_FILE_ROOTS.trim():"";if(configured)candidates=configured.split(":").map(x=>x.trim()).filter(Boolean);else{try{candidates=(await fs.readdir("/",{withFileTypes:true})).filter(e=>e.isDirectory()&&/^vol[0-9]+$/i.test(e.name)).map(e=>resolve("/",e.name));}catch{candidates=[];}}}const roots=[];for(const candidate of candidates){if(typeof candidate!=="string"||!isAbsolute(candidate))continue;try{const p=await fs.realpath(candidate),info=await fs.lstat(p);if(info.isDirectory()&&!roots.includes(p))roots.push(p);}catch{}}return roots.sort();}
 async function resolveExisting(value,expected="any"){if(typeof value!=="string"||!value.trim()||value.length>2048)fail(400,"Invalid path");const roots=await getRoots();let path;try{path=await fs.realpath(resolve(value));}catch{fail(404,"Path not found");}const root=roots.find(r=>within(r,path));if(!root)fail(403,"Path is outside configured storage roots");let info;try{info=await fs.lstat(resolve(value));}catch{fail(404,"Path not found");}if(info.isSymbolicLink())fail(403,"Symbolic links are not supported");if(expected==="file"&&!info.isFile())fail(400,"Expected a regular file");if(expected==="directory"&&!info.isDirectory())fail(400,"Expected a directory");if(path===root&&expected==="file")fail(400,"Storage root is not a file");return {path,root,info};}
 async function openValidatedFile(item) {
  let handle;
  try {
   handle = await fs.open(item.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
   const info = await handle.stat({ bigint: true });
   if (!info.isFile() || info.dev !== BigInt(item.info.dev) || info.ino !== BigInt(item.info.ino))
    fail(409, "File changed while opening; retry the operation");
   return { handle, info };
  } catch (error) {
   if (handle) await handle.close().catch(() => {});
   if (error?.code === "ELOOP" || error?.code === "ENOENT")
    fail(409, "File changed while opening; retry the operation");
   throw error;
  }
 }
 function sameIdentity(a, b) {
  return BigInt(a.dev) === BigInt(b.dev) && BigInt(a.ino) === BigInt(b.ino);
 }
 function descriptorPath(handle) {
  if (process.platform !== "linux") fail(503, "Secure file operations require Linux directory descriptors");
  return "/proc/self/fd/" + handle.fd;
 }
 async function openValidatedDirectory(item) {
  if (process.platform !== "linux") fail(503, "Secure file operations require Linux directory descriptors");
  let handle;
  try {
   handle = await fs.open(item.path, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
   const info = await handle.stat({ bigint: true });
   if (!info.isDirectory() || !sameIdentity(info, item.info)) fail(409, "Directory changed while opening; retry the operation");
   return { handle, path: descriptorPath(handle) };
  } catch (error) {
   if (handle) await handle.close().catch(() => {});
   if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error?.code))
    fail(409, "Directory changed while opening; retry the operation");
   throw error;
  }
 }
 async function verifyChildIdentity(path, expectedInfo) {
  let info;
  try { info = await fs.lstat(path); }
  catch (error) {
   if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
    fail(409, "File changed during operation; retry the operation");
   throw error;
  }
  if (info.isSymbolicLink() || !sameIdentity(info, expectedInfo))
   fail(409, "File changed during operation; retry the operation");
  return info;
 }
 async function destination(directory,name){const parent=await resolveExisting(directory,"directory"),clean=safeName(name),target=resolve(parent.path,clean);if(!within(parent.root,target)||target===parent.root)fail(403,"Path is outside configured storage roots");return {...parent,target,name:clean};}
 async function ensureAbsent(path){try{await fs.lstat(path);fail(409,"A file or directory with that name already exists");}catch(e){if(e.statusCode)throw e;if(e.code!=="ENOENT")throw e;}}
 async function preview(value) {
  const item = await resolveExisting(value, "file");
  const { handle, info } = await openValidatedFile(item);
  try {
   if (info.size > BigInt(MAX_PREVIEW_BYTES)) fail(413, "Preview is limited to 1 MiB");
   const chunks = [], buffer = Buffer.alloc(64 * 1024);
   let position = 0;
   while (position <= MAX_PREVIEW_BYTES) {
    const requested = Math.min(buffer.length, MAX_PREVIEW_BYTES + 1 - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead <= 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    position += bytesRead;
   }
   if (position > MAX_PREVIEW_BYTES) fail(413, "Preview is limited to 1 MiB");
   const b = Buffer.concat(chunks, position);
   if (b.includes(0)) fail(415, "Binary files cannot be previewed");
   let content;
   try { content = new TextDecoder("utf-8", { fatal: true }).decode(b); }
   catch { fail(415, "File is not valid UTF-8 text"); }
   return { name: basename(item.path), sizeBytes: position, content };
  } finally { await handle.close(); }
 }
 async function download(value) {
  const item = await resolveExisting(value, "file");
  const { handle, info } = await openValidatedFile(item);
  return { handle, name: basename(item.path), sizeBytes: Number(info.size) };
 }
 async function checksum(value) {
  const item = await resolveExisting(value, "file");
  const { handle, info: before } = await openValidatedFile(item);
  try {
    if (before.size > BigInt(MAX_CHECKSUM_BYTES)) fail(413, "SHA-256 calculation is limited to 256 MiB");
    const expectedSize = Number(before.size);
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(CHECKSUM_CHUNK_BYTES);
    let position = 0;
    while (position < expectedSize) {
      const requested = Math.min(chunk.length, expectedSize - position);
      const { bytesRead } = await handle.read(chunk, 0, requested, position);
      if (bytesRead <= 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (position !== expectedSize || after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      fail(409, "File changed while SHA-256 was being calculated; retry after writes finish");
    }
    return {
      name: basename(item.path),
      path: item.path,
      sizeBytes: position,
      algorithm: "SHA-256",
      sha256: hash.digest("hex")
    };
  } finally {
    await handle.close();
  }
 }
 async function createText(directory,name,content) {
  if (typeof content !== "string") fail(400, "Text content must be a string");
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length > MAX_TEXT_CREATE_BYTES) fail(413, "Text files are limited to 1 MiB");
  if (content.includes("\0")) fail(400, "Text content cannot contain NUL characters");
  const target = await destination(directory, name);
  const parent = await openValidatedDirectory(target);
  const targetPath = join(parent.path, target.name);
  let temp = null, created = false;
  try {
    await ensureAbsent(targetPath);
    temp = join(parent.path, ".fnos-text-" + randomUUID() + ".tmp");
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(buffer); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.link(temp, targetPath); created = true; }
    catch (error) {
      if (error?.code === "EEXIST") fail(409, "A file or directory with that name already exists");
      throw error;
    }
    return { name: target.name, path: target.target, sizeBytes: buffer.length };
  } catch (error) {
    if (created) await fs.unlink(targetPath).catch(() => {});
    throw error;
  } finally {
    if (temp) await fs.unlink(temp).catch(() => {});
    await parent.handle.close().catch(() => {});
  }
 }
 async function upload(directory,name,buffer) {
  if (!Buffer.isBuffer(buffer)) fail(400, "Upload body must be binary");
  if (buffer.length > MAX_UPLOAD_BYTES) fail(413, "Upload is limited to 25 MiB");
  const target = await destination(directory, name);
  const parent = await openValidatedDirectory(target);
  const targetPath = join(parent.path, target.name);
  let temp = null, created = false;
  try {
    await ensureAbsent(targetPath);
    temp = join(parent.path, ".fnos-upload-" + randomUUID() + ".tmp");
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(buffer); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.link(temp, targetPath); created = true; }
    catch (error) {
      if (error?.code === "EEXIST") fail(409, "A file or directory with that name already exists");
      throw error;
    }
    return { name: target.name, path: target.target, sizeBytes: buffer.length };
  } catch (error) {
    if (created) await fs.unlink(targetPath).catch(() => {});
    throw error;
  } finally {
    if (temp) await fs.unlink(temp).catch(() => {});
    await parent.handle.close().catch(() => {});
  }
 }
 async function operate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "Invalid operation");
  const action = input.action;
  if (action === "mkdir") {
    const d = await destination(input.path, input.name);
    const parent = await openValidatedDirectory(d);
    const targetPath = join(parent.path, d.name);
    try {
      await ensureAbsent(targetPath);
      await fs.mkdir(targetPath, { mode: 0o750 });
      return { action, name: d.name, path: d.target };
    } finally { await parent.handle.close().catch(() => {}); }
  }
  if (action === "rename" || action === "move") {
    const source = await resolveExisting(input.path);
    if (source.path === source.root) fail(403, "Cannot rename or move a storage root");
    const dir = action === "move" ? input.destination : dirname(source.path);
    const d = await destination(dir, action === "move" ? basename(source.path) : input.name);
    if (d.target === source.path) return { action, path: source.path, unchanged: true };
    const sourceParent = await resolveExisting(dirname(source.path), "directory");
    let sourceOpened = null, destinationOpened = null;
    try {
      sourceOpened = await openValidatedDirectory(sourceParent);
      const sourcePath = join(sourceOpened.path, basename(source.path));
      await verifyChildIdentity(sourcePath, source.info);
      destinationOpened = await openValidatedDirectory(d);
      const targetPath = join(destinationOpened.path, d.name);
      await ensureAbsent(targetPath);
      await fs.rename(sourcePath, targetPath);
      return { action, path: d.target, name: basename(d.target) };
    } finally {
      if (destinationOpened) await destinationOpened.handle.close().catch(() => {});
      if (sourceOpened) await sourceOpened.handle.close().catch(() => {});
    }
  }
  if (action === "delete") {
    if (input.confirm !== true) fail(400, "Explicit confirmation is required");
    const source = await resolveExisting(input.path);
    if (source.path === source.root) fail(403, "Cannot delete a storage root");
    const sourceParent = await resolveExisting(dirname(source.path), "directory");
    const parent = await openValidatedDirectory(sourceParent);
    try {
      const sourcePath = join(parent.path, basename(source.path));
      const info = await verifyChildIdentity(sourcePath, source.info);
      if (info.isDirectory()) await fs.rmdir(sourcePath);
      else if (info.isFile()) await fs.unlink(sourcePath);
      else fail(400, "Unsupported file type");
      return { action, path: source.path, deleted: true };
    } finally { await parent.handle.close().catch(() => {}); }
  }
  fail(400, "Unsupported file operation");
 }


  async function operateBatch(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.operations))
      fail(400, "Batch operations must be an array");
    if (input.operations.length < 1 || input.operations.length > 20)
      fail(400, "Batch operation count must be between 1 and 20");
    const results = [];
    let succeeded = 0, failed = 0;
    for (let index = 0; index < input.operations.length; index++) {
      const operation = input.operations[index];
      try {
        const result = await operate(operation);
        results.push({ index, ok: true, result });
        succeeded++;
      } catch (error) {
        results.push({
          index,
          ok: false,
          error: error?.statusCode === 400 ? "请求参数无效。" :
            error?.statusCode === 403 ? "操作路径不在允许范围内。" :
            error?.statusCode === 404 ? "文件或目录不存在。" :
            error?.statusCode === 409 ? "目标已存在或状态冲突。" :
            error?.statusCode === 413 ? "内容超过允许大小。" :
            "此项操作失败。"
        });
        failed++;
      }
    }
    return { total: input.operations.length, succeeded, failed, results };
  }

 return Object.freeze({getRoots,preview,download,checksum,upload,createText,operate,operateBatch,limits:{maxUploadBytes:MAX_UPLOAD_BYTES,maxPreviewBytes:MAX_PREVIEW_BYTES,maxTextCreateBytes:MAX_TEXT_CREATE_BYTES,maxChecksumBytes:MAX_CHECKSUM_BYTES}});
}
