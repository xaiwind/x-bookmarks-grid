// Small helpers over the File System Access API, used to save downloads into a folder the
// user picked. Paths are relative to that folder and use "/" between parts.

function splitPath(relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  return { folders: parts.slice(0, -1), name: parts.at(-1) || "" };
}

async function openFolder(rootHandle, folders, create) {
  let directory = rootHandle;
  for (const part of folders) directory = await directory.getDirectoryHandle(part, { create });
  return directory;
}

const isMissing = (failure) => failure?.name === "NotFoundError" || failure?.name === "TypeMismatchError";

/** @returns {Promise<boolean>} */
export async function fileExists(rootHandle, relativePath) {
  const { folders, name } = splitPath(relativePath);
  try {
    await (await openFolder(rootHandle, folders, false)).getFileHandle(name);
    return true;
  } catch (failure) {
    if (isMissing(failure)) return false;
    throw failure;
  }
}

/** @returns {Promise<Set<string>>} names in the folder that holds relativePath; empty when it does not exist yet */
export async function listSiblingNames(rootHandle, relativePath) {
  const { folders } = splitPath(relativePath);
  try {
    const directory = await openFolder(rootHandle, folders, false);
    const names = new Set();
    for await (const name of directory.keys()) names.add(name);
    return names;
  } catch (failure) {
    if (isMissing(failure)) return new Set();
    throw failure;
  }
}

export async function writeTextFile(rootHandle, relativePath, content) {
  const { folders, name } = splitPath(relativePath);
  const directory = await openFolder(rootHandle, folders, true);
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (failure) {
    await writable.abort().catch(() => {});
    throw failure;
  }
}

/** Removes a file if it is still there. */
export async function removeFile(rootHandle, relativePath) {
  const { folders, name } = splitPath(relativePath);
  try {
    await (await openFolder(rootHandle, folders, false)).removeEntry(name);
  } catch (failure) {
    if (!isMissing(failure)) throw failure;
  }
}

/**
 * Streams a download into a file, so large videos are never held in memory.
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {string} relativePath
 * @param {ReadableStream<Uint8Array>} stream
 */
export async function writeStreamFile(rootHandle, relativePath, stream) {
  const { folders, name } = splitPath(relativePath);
  const directory = await openFolder(rootHandle, folders, true);
  const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
  try {
    await stream.pipeTo(writable);
  } catch (failure) {
    await writable.abort().catch(() => {});
    throw failure;
  }
}

/** @returns {Promise<string>} the first bytes of a text file, enough to read its properties */
export async function readTextStart(rootHandle, relativePath, bytes = 4096) {
  const { folders, name } = splitPath(relativePath);
  const file = await (await (await openFolder(rootHandle, folders, false)).getFileHandle(name)).getFile();
  return file.slice(0, bytes).text();
}
