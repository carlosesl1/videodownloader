import { generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const force = process.argv.slice(2).includes('--force');
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--force');
if (unknownArguments.length > 0) {
  throw new Error(`Argumento desconhecido: ${unknownArguments[0]}`);
}

const manifestUrl = new URL('../manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
if (manifest.key && !force) {
  throw new Error('manifest.key já existe; use --force somente para trocar deliberadamente o ID.');
}

const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
});
manifest.key = publicKey.toString('base64');
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log('Chave pública SPKI gravada em manifest.json; nenhuma chave privada foi persistida.');
