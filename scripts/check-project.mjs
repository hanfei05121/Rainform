import { readFile, access } from 'node:fs/promises';

const requiredFiles = [
  'LICENSE',
  'NOTICE.md',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'index.html',
  'public/_headers',
  'public/robots.txt',
  'src/bootstrap.ts',
  'src/main.ts',
  'src/App.vue',
  'src/styles.css',
  'src/i18n/messages.ts',
  'src/engine/rainformEngine.ts',
  'vite.config.ts'
];

for (const file of requiredFiles) {
  await access(file);
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (packageJson.name !== 'rainform') throw new Error('package.json name must remain "rainform".');
if (packageJson.license !== 'PolyForm-Noncommercial-1.0.0') {
  throw new Error('package.json must declare PolyForm-Noncommercial-1.0.0.');
}
if (packageJson.private !== true) {
  throw new Error('Rainform must be marked private to prevent accidental npm publication.');
}

const engineSource = await readFile('src/engine/rainformEngine.ts', 'utf8');
const bootstrapSource = await readFile('src/bootstrap.ts', 'utf8');
const appSource = await readFile('src/App.vue', 'utf8');
const mainSource = await readFile('src/main.ts', 'utf8');
const viteSource = await readFile('vite.config.ts', 'utf8');
const messagesSource = await readFile('src/i18n/messages.ts', 'utf8');
const html = await readFile('index.html', 'utf8');

if (!engineSource.includes('const ENABLE_TUNING_CONSOLE = import.meta.env.DEV;')) {
  throw new Error('The visual tuning console must remain development-only.');
}
if (!appSource.includes('if (import.meta.env.DEV)')) {
  throw new Error('App.vue must keep the tuning console behind an import.meta.env.DEV guard.');
}
if (/^\s*import\s+TuningConsolePanel\b/m.test(appSource)) {
  throw new Error('TuningConsolePanel must be loaded lazily so it can be tree-shaken from production.');
}
if (!viteSource.includes('sourcemap: false')) {
  throw new Error('Production source maps must remain disabled.');
}
for (const [file, source] of [
  ['src/main.ts', mainSource],
  ['src/bootstrap.ts', bootstrapSource],
  ['src/engine/rainformEngine.ts', engineSource],
  ['src/App.vue', appSource]
]) {
  if (!source.includes('Required Notice: Rainform / 数据成雨')) {
    throw new Error(`${file} is missing the required copyright notice.`);
  }
}
if (!html.includes('PolyForm Noncommercial 1.0.0')) {
  throw new Error('index.html is missing the source license notice.');
}
if (!html.includes('<div id="app">')) {
  throw new Error('index.html must provide the #app mount point for the Vue shell.');
}
if (!bootstrapSource.includes('__rainAudioReady')) {
  throw new Error('src/bootstrap.ts must expose the rain audio preload promise.');
}

function objectKeys(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) throw new Error(`Could not inspect translations around ${startMarker}.`);
  return [...source.slice(start, end).matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)]
    .map(match => match[1])
    .sort();
}

const zhKeys = objectKeys(messagesSource, "  'zh-CN': {", '  en: {');
const enKeys = objectKeys(messagesSource, '  en: {', '\n  }\n};');
if (zhKeys.join('\n') !== enKeys.join('\n')) {
  const onlyZh = zhKeys.filter(key => !enKeys.includes(key));
  const onlyEn = enKeys.filter(key => !zhKeys.includes(key));
  throw new Error(`Translation keys differ. zh-only: ${onlyZh.join(', ')}; en-only: ${onlyEn.join(', ')}`);
}

console.log(`Project checks passed (${zhKeys.length} complete translation keys per locale).`);
