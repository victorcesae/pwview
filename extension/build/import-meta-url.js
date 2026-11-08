// The Agent SDK is ESM and uses import.meta.url; this gives it a real value in our CommonJS bundle.
export const importMetaUrl = require('url').pathToFileURL(__filename).href;
