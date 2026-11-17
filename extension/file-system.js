export async function writeTextFile(rootHandle, relativePath, content) {
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.pop();
  let dir = rootHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const file = await dir.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function readTextFile(rootHandle, relativePath, fallback = "") {
  try {
    const parts = relativePath.split("/").filter(Boolean);
    const filename = parts.pop();
    let dir = rootHandle;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part);
    }
    const file = await dir.getFileHandle(filename);
    return await (await file.getFile()).text();
  } catch {
    return fallback;
  }
}
