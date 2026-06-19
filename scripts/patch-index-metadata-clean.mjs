import fs from 'node:fs';
const file = 'functions/utils/indexManager.js';
let s = fs.readFileSync(file, 'utf8');
if (!s.includes("metadata/metadataSecurity.js")) {
  s = s.replace("import { getDatabase, checkDatabaseConfig } from './databaseAdapter.js';", "import { getDatabase, checkDatabaseConfig } from './databaseAdapter.js';\nimport { cleanPersistedMetadata } from './metadata/metadataSecurity.js';");
}
s = s.replace(/fileId,\s*metadata\s*\}\);/g, "fileId,\n            metadata: cleanPersistedMetadata(metadata)\n        });");
s = s.replace(/metadata: finalMetadata/g, "metadata: cleanPersistedMetadata(finalMetadata)");
s = s.replace(/metadata: metadata/g, "metadata: cleanPersistedMetadata(metadata)");
fs.writeFileSync(file, s, 'utf8');
