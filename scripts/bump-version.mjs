import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function nextVersion(version){
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if(!match) throw new Error(`Invalid semantic version: ${version}`);
  let [, major, minor, patch] = match.map(Number);
  patch += 1;
  if(patch >= 10){
    patch = 0;
    minor += 1;
  }
  if(minor >= 10){
    minor = 0;
    major += 1;
  }
  return `${major}.${minor}.${patch}`;
}

export async function bumpVersionFile(filePath){
  const source = await readFile(filePath, 'utf8');
  const match = source.match(/APP_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/);
  if(!match) throw new Error(`APP_VERSION was not found in ${filePath}`);
  const next = nextVersion(match[1]);
  await writeFile(filePath, source.replace(match[1], next), 'utf8');
  return next;
}

if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  const filePath = process.argv[2];
  if(!filePath) throw new Error('Usage: node scripts/bump-version.mjs <version-file>');
  console.log(await bumpVersionFile(filePath));
}
