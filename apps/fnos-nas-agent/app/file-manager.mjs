import { readdir, lstat, realpath, mkdir, open, link, unlink, rename, rmdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hasDeleteCapability } from "./execution-capability.mjs";
import { compareRootPaths } from "./file-browser.mjs";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024, MAX_PREVIEW_BYTES = 1024 * 1024, MAX_TEXT_CREATE_BYTES = 1024 * 1024;
export const MAX_CHECKSUM_BYTES = 256 * 1024 * 1024;
const CHECKSUM_CHUNK_BYTES = 1024 * 1024;
function within(root,target){const rel=relative(root,target);return rel===""||(!rel.startsWith(".."+sep)&&rel!==".."&&!isAbsolute(rel));}
function fail(statusCode,message){throw Object.assign(new Error(message),{statusCode});}
// Native filesystem errors carry a machine readable code. Without a mapping the
// generic handler would answer 500 for conditions the client can act on, such as
// a name that already exists or a directory that is not empty.
const ERRNO_STATUS={EEXIST:409,ENOTEMPTY:409,EBUSY:409,EXDEV:400,EACCES:403,EPERM:403,EROFS:403,ENOSPC:507,EDQUOT:507,ENOENT:404,ENOTDIR:400,EISDIR:400,ELOOP:400,EFBIG:413,EMFILE:503,ENFILE:503,ENODEV:400};
const ERRNO_MESSAGE={EEXIST:"A file or directory with that name already exists",ENOTEMPTY:"The directory is not empty",EBUSY:"The item is busy",EXDEV:"The item cannot be moved across storage roots",EACCES:"Access to the item was denied",EPERM:"The operation is not permitted",EROFS:"The storage is read only",ENOSPC:"The storage is full",EDQUOT:"The storage quota is exhausted",ENOENT:"Path not found",ENOTDIR:"A path segment is not a directory",EISDIR:"The path is a directory",ELOOP:"The path contains a symbolic link",EFBIG:"The file is too large",EMFILE:"Too many open files",ENFILE:"Too many open files",ENODEV:"The operation is not supported on this device"};
function failNative(error){const status=ERRNO_STATUS[error?.code];if(!status)throw error;fail(status,ERRNO_MESSAGE[error.code]||"The file operation failed");}
// A 403 is not one condition but several. The batch result tells the caller
// which one applies instead of folding them into a single opaque sentence.
const FORBIDDEN_REASONS=new Map([
 ["Path is outside configured storage roots","操作路径不在允许的存储卷范围内。"],
 ["Symbolic links are not supported","该路径是符号链接，文件域操作不支持符号链接。"],
 ["Cannot rename or move a storage root","不能重命名或移动存储卷根目录。"],
 ["Cannot delete a storage root","不能删除存储卷根目录。"],
 ["Explicit confirmation is required: destructive deletion must be authorized by the server","删除操作缺少服务端签发的授权凭据。"]
]);
// The same mapping in a form that a caller (or a test) can inspect without
// throwing.
export function nativeErrorStatus(error){const status=ERRNO_STATUS[error?.code];if(!status)return null;return {statusCode:status,message:ERRNO_MESSAGE[error.code]||"The file operation failed"};}
// Staged write files live in the target directory under this prefix. They are
// internal bookkeeping: the browser filters them out of every listing and
// search, and a write removes the stale ones of the same directory.
export const TEMP_FILE_PREFIX = ".fnos-tmp-";
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A file system that does not support hard links cannot publish a staged file
// with link(2). The published file is then renamed into place instead, which
// keeps the same atomic "either the old or the new content" guarantee.
const LINK_FALLBACK_CODES=["EPERM","ENOTSUP","EOPNOTSUPP","EXDEV","EMLINK","ENOSYS","EINVAL"];
/**
 * Publishes a staged temporary file as the final target.
 *
 * The hard link is the preferred path: it fails when the target already exists
 * and it never replaces a file that appeared in the meantime. When the file
 * system does not support hard links the staged file is renamed into place
 * instead. The rename replaces an existing target, so the "the target must not
 * exist" check is repeated right before the rename.
 *
 * @returns {"hard-link"|"atomic-rename"} the strategy that published the file
 */
export async function publishStagedFile({fs, tempPath, targetPath, ensureAbsent}){
 try{await fs.link(tempPath,targetPath);return "hard-link";}
 catch(error){
  if(error?.code==="EEXIST")fail(409,"A file or directory with that name already exists");
  if(!LINK_FALLBACK_CODES.includes(error?.code))throw error;
  if(typeof ensureAbsent==="function")await ensureAbsent();
  try{await fs.rename(tempPath,targetPath);}
  catch(renameError){if(renameError?.code==="EEXIST")fail(409,"A file or directory with that name already exists");throw renameError;}
  return "atomic-rename";
 }
}
function safeName(name){if(typeof name!=="string"||!name.trim()||name.length>255||name==="."||name===".."||/[\\/\0]/.test(name)||name.trim()!==name||/[\x00-\x1f\x7f]/.test(name))fail(400,"Invalid file name");return name;}
/**
 * Decodes a preview buffer as text.
 *
 * A NUL byte marks binary content, but a UTF-16 text file consists mostly of
 * NUL bytes (one per ASCII character). The byte order mark therefore decides
 * the encoding before the binary check runs, so a UTF-16 document is decoded
 * instead of refused as binary.
 */
export function decodePreviewBuffer(buffer){
 const b=Buffer.isBuffer(buffer)?buffer:Buffer.from(buffer);
 if(b.length>=2){
  if(b[0]===0xFF&&b[1]===0xFE)return decodeUtf16(b.subarray(2),"utf-16le");
  if(b[0]===0xFE&&b[1]===0xFF)return decodeUtf16(b.subarray(2),"utf-16be");
 }
 if(b.includes(0))fail(415,"Binary files cannot be previewed");
 try{return new TextDecoder("utf-8",{fatal:true}).decode(b);}
 catch{fail(415,"File is not valid UTF-8 text");}
}
function decodeUtf16(buffer,encoding){
 try{return new TextDecoder(encoding,{fatal:true}).decode(buffer);}
 catch{fail(415,"File is not valid UTF-16 text");}
}
/**
 * Moves an entry to a new name without ever replacing an existing target.
 *
 * A plain rename(2) silently replaces the target on POSIX, so the target name
 * is claimed before the source disappears:
 *  - a regular file is moved with link(2) + unlink(2). link(2) fails with
 *    EEXIST when the name is taken, so the target can never be destroyed.
 *  - when the file system does not support hard links (or the source is a
 *    directory) an exclusive placeholder claims the name: mkdir(2) or an
 *    O_EXCL create fails with EEXIST when the name is taken, and the rename
 *    then replaces only the placeholder this call created.
 *
 * @returns {"link-unlink"|"placeholder-rename"} the strategy that moved the entry
 */
export async function moveEntryWithoutOverwrite({fs,sourcePath,targetPath,sourceIsDirectory}){
 if(!sourceIsDirectory){
  let linked=false;
  try{await fs.link(sourcePath,targetPath);linked=true;}
  catch(error){
   if(error?.code==="EEXIST")fail(409,"A file or directory with that name already exists");
   if(!LINK_FALLBACK_CODES.includes(error?.code))throw error;
  }
  if(linked){
   try{await fs.unlink(sourcePath);}
   catch(error){await fs.unlink(targetPath).catch(()=>{});throw error;}
   return "link-unlink";
  }
 }
 let placeholderIsDirectory=false;
 try{
  if(sourceIsDirectory){await fs.mkdir(targetPath);placeholderIsDirectory=true;}
  else{const handle=await fs.open(targetPath,"wx");await handle.close();}
 }catch(error){
  if(error?.code==="EEXIST")fail(409,"A file or directory with that name already exists");
  throw error;
 }
 try{await fs.rename(sourcePath,targetPath);}
 catch(error){
  if(placeholderIsDirectory)await fs.rmdir(targetPath).catch(()=>{});
  else await fs.unlink(targetPath).catch(()=>{});
  throw error;
 }
 return "placeholder-rename";
}
/**
 * Puts a moved entry back at its old name.
 *
 * The restore never overwrites a name that was taken in the meantime: a
 * regular file is restored with a hard link, and a name that is occupied makes
 * the restore fail instead of destroying the new occupant.
 */
export async function restoreMovedEntry({fs,fromPath,toPath,isDirectory,strategy}){
 if(strategy==="link-unlink"&&!isDirectory){
  await fs.link(fromPath,toPath);
  await fs.unlink(fromPath);
  return;
 }
 await fs.rename(fromPath,toPath);
}
export function createFileManager({roots:suppliedRoots,env=process.env,fs={readdir,lstat,realpath,mkdir,open,link,unlink,rename,rmdir,readFile},descriptorPathFor=null}={}){
 async function getRoots(){let candidates=suppliedRoots;if(!Array.isArray(candidates)){const configured=typeof env.AGENT_FILE_ROOTS==="string"?env.AGENT_FILE_ROOTS.trim():"";if(configured)candidates=configured.split(":").map(x=>x.trim()).filter(Boolean);else{try{candidates=(await fs.readdir("/",{withFileTypes:true})).filter(e=>e.isDirectory()&&/^vol[0-9]+$/i.test(e.name)).map(e=>resolve("/",e.name));}catch{candidates=[];}}}const roots=[];for(const candidate of candidates){if(typeof candidate!=="string"||!isAbsolute(candidate))continue;try{const p=await fs.realpath(candidate),info=await fs.lstat(p);if(info.isDirectory()&&!roots.includes(p))roots.push(p);}catch{}}return roots.sort(compareRootPaths);}
 async function resolveExisting(value,expected="any"){if(typeof value!=="string"||!value.trim()||value.length>2048)fail(400,"Invalid path");const roots=await getRoots();const requested=resolve(value);let path;try{path=await fs.realpath(requested);}catch{fail(404,"Path not found");}let info;try{info=await fs.lstat(requested,{bigint:true});}catch{fail(404,"Path not found");}
  // A symbolic link is refused with its own reason. The link may well live
  // inside a storage root, so answering "outside the storage roots" would
  // point the caller at the wrong problem. The lstat deliberately runs after
  // the realpath so that a path swapped underneath us is still reported as a
  // changed entry (409) instead of an outside path.
  if(info.isSymbolicLink())fail(403,"Symbolic links are not supported");
  const root=roots.find(r=>within(r,path));if(!root)fail(403,"Path is outside configured storage roots");if(expected==="file"&&!info.isFile())fail(400,"Expected a regular file");if(expected==="directory"&&!info.isDirectory())fail(400,"Expected a directory");if(path===root&&expected==="file")fail(400,"Storage root is not a file");return {path,root,info};}
 /**
  * Resolves a symbolic link entry without resolving its target.
  *
  * A symbolic link is never followed. The link itself is a regular directory
  * entry that the user may want to remove, so the parent directory is
  * validated and the link entry is returned for an unlink that touches the
  * link and never the target.
  *
  * @returns {null|{path:string,root:string,info:object,parentPath:string,parentInfo:object}}
  */
 async function resolveLinkEntry(value){
  if(typeof value!=="string"||!value.trim()||value.length>2048)fail(400,"Invalid path");
  const roots=await getRoots();
  const requested=resolve(value);
  let info;try{info=await fs.lstat(requested,{bigint:true});}catch{fail(404,"Path not found");}
  if(!info.isSymbolicLink())return null;
  const parentPath=dirname(requested);
  let parentInfo;try{parentInfo=await fs.lstat(parentPath,{bigint:true});}catch{fail(404,"Path not found");}
  if(parentInfo.isSymbolicLink()||!parentInfo.isDirectory())fail(403,"Path is outside configured storage roots");
  let realParent;try{realParent=await fs.realpath(parentPath);}catch{fail(404,"Path not found");}
  const root=roots.find(r=>within(r,realParent));
  if(!root)fail(403,"Path is outside configured storage roots");
  const linkPath=resolve(realParent,basename(requested));
  if(!within(root,linkPath))fail(403,"Path is outside configured storage roots");
  return {path:linkPath,root,info,parentPath:realParent,parentInfo};
 }
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
  // A caller may supply the descriptor path resolution (the test seam). The
  // production path stays platform guarded: without a Linux directory
  // descriptor the operation is refused instead of using a plain path.
  if (typeof descriptorPathFor === "function") return descriptorPathFor(handle);
  if (process.platform !== "linux") fail(503, "Secure file operations require Linux directory descriptors");
  return "/proc/self/fd/" + handle.fd;
 }
 async function openValidatedDirectory(item) {
  if (typeof descriptorPathFor !== "function" && process.platform !== "linux") fail(503, "Secure file operations require Linux directory descriptors");
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
  try { info = await fs.lstat(path, { bigint: true }); }
  catch (error) {
   if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
    fail(409, "File changed during operation; retry the operation");
   throw error;
  }
  if (info.isSymbolicLink() || !sameIdentity(info, expectedInfo))
   fail(409, "File changed during operation; retry the operation");
  return info;
 }
 async function ensureDirectoryPathStillMatches(item) {
  let actual, info;
  try {
   actual = await fs.realpath(item.path);
   info = await fs.lstat(item.path, { bigint: true });
  } catch (error) {
   if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code))
    fail(409, "Directory changed during operation; retry the operation");
   throw error;
  }
  if (actual !== item.path || info.isSymbolicLink() || !sameIdentity(info, item.info))
   fail(409, "Directory changed during operation; retry the operation");
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
   const content = decodePreviewBuffer(b);
   return { name: basename(item.path), path: item.path, sizeBytes: position, content };
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
 /**
  * Removes the staged write files that a crashed write left behind.
  *
  * Only stage files of the same directory and only the ones that are older
  * than the retention window are removed: a concurrent write still owns its
  * own stage file.
  */
 async function cleanupStaleTempFiles(directoryPath){
  let names;
  try { names = await fs.readdir(directoryPath); }
  catch { return 0; }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
   if (!name.startsWith(TEMP_FILE_PREFIX)) continue;
   const candidate = join(directoryPath, name);
   try {
    const info = await fs.lstat(candidate);
    if (now - Number(info.mtimeMs) < TEMP_FILE_MAX_AGE_MS) continue;
    await fs.unlink(candidate);
    removed++;
   } catch { /* A stage file that vanished or is still open is left alone. */ }
  }
  return removed;
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
    await cleanupStaleTempFiles(parent.path);
   temp = join(parent.path, TEMP_FILE_PREFIX + randomUUID() + ".tmp");
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(buffer); await handle.sync(); }
    finally { await handle.close(); }
    await publishStagedFile({ fs, tempPath: temp, targetPath, ensureAbsent: () => ensureAbsent(targetPath) });
    created = true;
    await ensureDirectoryPathStillMatches(target);
    return { name: target.name, path: target.target, sizeBytes: buffer.length };
  } catch (error) {
    if (created) await fs.unlink(targetPath).catch(() => {});
    // A native error (ENOSPC, EDQUOT, EACCES, EPERM) carries a machine
    // readable code. The generic handler would answer 500 for a condition the
    // client can act on, so the native code is mapped to a status here.
    failNative(error);
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
    await cleanupStaleTempFiles(parent.path);
   temp = join(parent.path, TEMP_FILE_PREFIX + randomUUID() + ".tmp");
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(buffer); await handle.sync(); }
    finally { await handle.close(); }
    await publishStagedFile({ fs, tempPath: temp, targetPath, ensureAbsent: () => ensureAbsent(targetPath) });
    created = true;
    await ensureDirectoryPathStillMatches(target);
    return { name: target.name, path: target.target, sizeBytes: buffer.length };
  } catch (error) {
    if (created) await fs.unlink(targetPath).catch(() => {});
    // A native error (ENOSPC, EDQUOT, EACCES, EPERM) carries a machine
    // readable code. The generic handler would answer 500 for a condition the
    // client can act on, so the native code is mapped to a status here.
    failNative(error);
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
      try { await fs.mkdir(targetPath, { mode: 0o750 }); }
      catch (error) { failNative(error); }
      try { await ensureDirectoryPathStillMatches(d); }
      catch (error) { await fs.rmdir(targetPath).catch(() => {}); throw error; }
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
      const sourceInfo = await verifyChildIdentity(sourcePath, source.info);
      destinationOpened = await openValidatedDirectory(d);
      const targetPath = join(destinationOpened.path, d.name);
      await ensureAbsent(targetPath);
      // The move never replaces an existing target: the target name is claimed
      // atomically (link(2) or an exclusive placeholder fails with EEXIST)
      // before the source entry disappears.
      let strategy;
      try { strategy = await moveEntryWithoutOverwrite({ fs, sourcePath, targetPath, sourceIsDirectory: sourceInfo.isDirectory() }); }
      catch (error) { failNative(error); }
      try {
        await ensureDirectoryPathStillMatches(sourceParent);
        await ensureDirectoryPathStillMatches(d);
      } catch (error) {
        // The move already happened. The rollback puts the entry back, and a
        // rollback that fails is reported with the original error instead of
        // being swallowed: the entry now lives under the new name.
        try { await restoreMovedEntry({ fs, fromPath: targetPath, toPath: sourcePath, isDirectory: sourceInfo.isDirectory(), strategy }); }
        catch (rollbackError) { error.rollbackError = rollbackError; }
        throw error;
      }
      return { action, path: d.target, name: basename(d.target) };
    } finally {
      if (destinationOpened) await destinationOpened.handle.close().catch(() => {});
      if (sourceOpened) await sourceOpened.handle.close().catch(() => {});
    }
  }
  if (action === "delete") {
    // A client supplied boolean (for example "confirm": true) is NOT an authorization.
    // Only the module-private delete capability minted by the server counts.
    if (!hasDeleteCapability(input.capability)) fail(403, "Explicit confirmation is required: destructive deletion must be authorized by the server");
    // A symbolic link is removed as a link: only the link entry in its parent
    // directory is unlinked, the target of the link is never touched.
    const link = await resolveLinkEntry(input.path);
    if (link) {
      const parent = await openValidatedDirectory({ path: link.parentPath, root: link.root, info: link.parentInfo });
      try {
        const linkPath = join(parent.path, basename(link.path));
        await ensureDirectoryPathStillMatches({ path: link.parentPath, info: link.parentInfo });
        try { await fs.unlink(linkPath); }
        catch (error) { failNative(error); }
        return { action, path: link.path, deleted: true, symbolicLink: true };
      } finally { await parent.handle.close().catch(() => {}); }
    }
    const source = await resolveExisting(input.path);
    if (source.path === source.root) fail(403, "Cannot delete a storage root");
    const sourceParent = await resolveExisting(dirname(source.path), "directory");
    const parent = await openValidatedDirectory(sourceParent);
    try {
      const sourcePath = join(parent.path, basename(source.path));
      await ensureDirectoryPathStillMatches(sourceParent);
      const info = await verifyChildIdentity(sourcePath, source.info);
      try {
        if (info.isDirectory()) await fs.rmdir(sourcePath);
        else if (info.isFile()) await fs.unlink(sourcePath);
        else fail(400, "Unsupported file type");
      } catch (error) { failNative(error); }
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
    // A batch that contains a destructive entry must carry the server-side capability;
    // otherwise the whole batch is refused instead of silently skipping the delete.
    for (const operation of input.operations) {
      if (operation && typeof operation === "object" && operation.action === "delete" && !hasDeleteCapability(operation.capability))
        fail(403, "Explicit confirmation is required: destructive deletion must be authorized by the server");
    }
    const results = [];
    let succeeded = 0, failed = 0;
    for (let index = 0; index < input.operations.length; index++) {
      const operation = input.operations[index];
      try {
        const result = await operate(operation);
        results.push({ index, ok: true, result });
        succeeded++;
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        // A 403 has several causes: a path outside the storage roots, a
        // symbolic link, a storage root itself, or a missing delete
        // capability. The reason is reported so the caller knows which one
        // applies instead of receiving a single opaque sentence.
        const forbiddenReason = statusCode === 403 ? FORBIDDEN_REASONS.get(error?.message) : undefined;
        const failure = {
          index,
          ok: false,
          statusCode,
          error: statusCode === 400 ? "请求参数无效。" :
            statusCode === 403 ? (forbiddenReason || "操作路径不在允许范围内。") :
            statusCode === 404 ? "文件或目录不存在。" :
            statusCode === 409 ? "目标已存在或状态冲突。" :
            statusCode === 413 ? "内容超过允许大小。" :
            statusCode === 415 ? "文件类型不受支持。" :
            statusCode === 503 ? "存储暂时不可用。" :
            statusCode === 507 ? "存储空间不足。" :
            "此项操作失败。"
        };
        if (statusCode === 403 && typeof error?.message === "string") failure.reason = error.message;
        results.push(failure);
        failed++;
      }
    }
    return { total: input.operations.length, succeeded, failed, results };
  }

 return Object.freeze({getRoots,preview,download,checksum,upload,createText,operate,operateBatch,limits:{maxUploadBytes:MAX_UPLOAD_BYTES,maxPreviewBytes:MAX_PREVIEW_BYTES,maxTextCreateBytes:MAX_TEXT_CREATE_BYTES,maxChecksumBytes:MAX_CHECKSUM_BYTES}});
}
