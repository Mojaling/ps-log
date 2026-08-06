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

export function compareVersions(left, right){
  const parse = value => {
    const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)$/);
    if(!match) throw new Error(`Invalid semantic version: ${value}`);
    return match.slice(1).map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for(let index=0; index<a.length; index++){
    if(a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function versionFromSource(source, filePath = 'version.js'){
  if(/^(<<<<<<<|=======|>>>>>>>)/m.test(String(source))){
    throw new Error(`Git merge conflict markers remain in ${filePath}. Restore this file from the upstream branch before deploying.`);
  }
  const matches = [...String(source).matchAll(/APP_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/g)];
  if(matches.length !== 1) throw new Error(`Exactly one APP_VERSION is required in ${filePath}`);
  return matches[0][1];
}

export async function bumpVersionFile(filePath, previousDeployVersion = ''){
  const source = await readFile(filePath, 'utf8');
  const sourceVersion = versionFromSource(source, filePath);
  const baseVersion = previousDeployVersion && compareVersions(previousDeployVersion, sourceVersion) > 0
    ? previousDeployVersion : sourceVersion;
  const next = nextVersion(baseVersion);
  await writeFile(filePath, source.replace(sourceVersion, next), 'utf8');
  return next;
}

if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  const filePath = process.argv[2];
  if(!filePath) throw new Error('Usage: node scripts/bump-version.mjs <version-file>');
  console.log(await bumpVersionFile(filePath, process.argv[3] || ''));
}
