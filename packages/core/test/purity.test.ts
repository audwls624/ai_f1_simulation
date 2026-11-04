/**
 * DESIGN.md 16절 "순수성": core에서 Date, Math.random, process, fetch 등을 쓰면 lint가 실패해야 한다.
 * 실제 eslint 설정으로 가짜 core 파일을 lint해서 확인한다 (설정이 바뀌어 규칙이 빠지면 여기서 잡힌다).
 */
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function ruleIds(code: string, file = 'packages/core/src/__purity_probe__.ts'): Promise<(string | null)[]> {
  const [result] = await eslint.lintText(code, { filePath: `${repoRoot}${file}` });
  return result?.messages.map((m) => m.ruleId) ?? ['<no result>'];
}

describe('core purity lint', { timeout: 30_000 }, () => {
  it.each([
    ['Date', 'export const t = Date.now();', 'no-restricted-globals'],
    ['new Date', 'export const t = new Date();', 'no-restricted-globals'],
    ['Math.random', 'export const r = Math.random();', 'no-restricted-properties'],
    ['process', 'export const e = process.env;', 'no-restricted-globals'],
    ['fetch', 'export const f = () => fetch("https://example.com");', 'no-restricted-globals'],
    ['console', 'export const log = () => console.log(1);', 'no-restricted-globals'],
    ['window', 'export const w = window;', 'no-restricted-globals'],
    ['document', 'export const d = document;', 'no-restricted-globals'],
    ['globalThis', 'export const d = globalThis;', 'no-restricted-globals'],
    ['performance', 'export const t = performance.now();', 'no-restricted-globals'],
    ['node:fs import', 'import { readFileSync } from "node:fs";\nexport const r = readFileSync;', 'no-restricted-imports'],
    ['fs import', 'import fs from "fs";\nexport const r = fs;', 'no-restricted-imports'],
    ['other workspace package', 'import * as a from "@f1sim/agents";\nexport const x = a;', 'no-restricted-imports'],
    ['for...in', 'export function f(o: object) { let n = 0; for (const _k in o) n++; return n; }', 'no-restricted-syntax'],
    ['Object.keys', 'export const k = Object.keys({});', 'no-restricted-properties'],
    ['localeCompare', 'export const c = "a".localeCompare("b");', 'no-restricted-properties'],
    ['import.meta', 'export const u = import.meta.url;', 'no-restricted-syntax'],
  ])('forbids %s', async (_name, code, rule) => {
    expect(await ruleIds(code)).toContain(rule);
  });

  it('allows zod, yaml, relative imports and pure Math', async () => {
    const code = [
      'import { z } from "zod";',
      'import { parseDocument } from "yaml";',
      'import { makeRng } from "./rng.js";',
      'export const ok = [z, parseDocument, makeRng, Math.sqrt(2), Math.exp(1)];',
    ].join('\n');
    expect(await ruleIds(code)).toEqual([]);
  });

  it('applies only to packages/core/src', async () => {
    expect(await ruleIds('export const t = Date.now();', 'packages/agents/src/__purity_probe__.ts')).toEqual([]);
    expect(await ruleIds('export const t = Date.now();', 'packages/core/test/__purity_probe__.ts')).toEqual([]);
  });
});
