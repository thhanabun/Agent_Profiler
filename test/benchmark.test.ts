import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyWordstats } from '../benchmarks/wordstats.js';

test('wordstats benchmark checks Unicode, newline rules and CLI behavior without model calls', async () => {
  const parent = path.resolve('.subharness/tests'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'benchmark-'));
  try {
    await writeFile(path.join(root, 'stats.mjs'), `export function analyze(text) { return {characters:[...text].length,words:text.trim()?text.trim().split(/\\s+/u).length:0,lines:text?text.split(/\\r\\n|\\r|\\n/).length-(/(?:\\r\\n|\\r|\\n)$/.test(text)?1:0):0}; }`);
    await writeFile(path.join(root, 'cli.mjs'), `import {readFileSync} from 'node:fs';import {analyze} from './stats.mjs';
if(process.argv.slice(2).length){if(process.argv.length===3&&process.argv[2]==='--help'){console.log('Usage: node cli.mjs');}else{console.error('Unknown argument');process.exitCode=2;}}
else console.log(JSON.stringify(analyze(readFileSync(0,'utf8'))));`);
    const correct = await verifyWordstats(root);
    assert.equal(correct.length, 13); assert(correct.every(check => check.passed), JSON.stringify(correct));
    await writeFile(path.join(root, 'stats.mjs'), 'export const analyze = () => ({lines:0,words:0,characters:0});');
    const wrong = await verifyWordstats(root);
    assert(wrong.some(check => !check.passed));
    assert.equal(wrong.find(check => check.name === 'Unicode code points')!.passed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
