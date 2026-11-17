export function getStorage(keys) {
  return new Promise((resolve, reject) => chrome.storage.local.get(keys, (result) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve(result);
  }));
}

export function setStorage(values) {
  return new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve();
  }));
}

export function removeStorage(keys) {
  return new Promise((resolve, reject) => chrome.storage.local.remove(keys, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve();
  }));
}
