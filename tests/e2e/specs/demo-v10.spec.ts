/**
 * Demo v0.10 (docs/TASKS.md): "rã một báo cáo 2 cột có bảng thành Word 'giữ bố cục' và Markdown".
 *
 * What runs where: fixtures/demo_v10_export.py starts the REAL core, analyses the two-column report
 * (layout.analyze) and exports it to DOCX in both modes and to Markdown (export.document). Then
 * fixtures/demo_v10_check.py measures the files themselves with python-docx and plain text. This
 * test covers the core end to end; the review screen is covered by layout-review.spec.ts.
 *
 * NOT TESTED: opening the DOCX in Microsoft Word or LibreOffice (kept for the owner's manual check).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { removeTempDirs, repoRoot } from '../fixtures/app';

const coreDir = path.join(repoRoot, 'core');
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');

interface Manifest {
  files: { layoutDocx: string; editableDocx: string; markdown: string };
  summary: unknown;
}
interface DocxReport {
  bytes: number;
  tables: number;
  tableRows: number;
  tableColumns: number;
  tableHeader: string[];
  sections: number;
  headerInBody: boolean;
  footerInBody: boolean;
  pageNumberInBody: boolean;
  titleCount: number;
  headingOrder: string[];
  vietnameseKept: boolean;
  layoutSections: boolean;
}
interface MarkdownReport {
  bytes: number;
  pipeRows: number;
  separatorRows: number;
  tableHeader: string[];
  headingLevels: number[];
  headerInBody: boolean;
  footerInBody: boolean;
}
interface CheckResult {
  layout: DocxReport;
  editable: DocxReport;
  markdown: MarkdownReport;
}

let workDir = '';

test.describe.configure({ mode: 'serial' });

function py(script: string, ...args: string[]): string {
  return execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', path.join(fixturesDir, script), ...args],
    { cwd: repoRoot, encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'ignore'] },
  );
}

test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-demo-v10-'));
});

test.afterAll(() => {
  removeTempDirs();
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('a two-column report with a ruled table becomes DOCX (layout and editable) and Markdown', async () => {
  test.setTimeout(900_000);
  const exported = path.join(workDir, 'rut');
  const manifestFile = path.join(workDir, 'manifest.json');
  fs.writeFileSync(manifestFile, py('demo_v10_export.py', exported), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Manifest;

  for (const file of Object.values(manifest.files))
    expect(fs.statSync(file).size).toBeGreaterThan(0);

  const result = JSON.parse(py('demo_v10_check.py', manifestFile)) as CheckResult;
  const { layout, editable, markdown } = result;

  // Both DOCX files keep the ruled table: 3 rows, 4 columns, the header row as written.
  for (const docx of [layout, editable]) {
    expect(docx.tables).toBe(1);
    expect(docx.tableRows).toBe(3);
    expect(docx.tableColumns).toBe(4);
    expect(docx.tableHeader).toEqual(['Quý', 'Doanh thu', 'Chi phí', 'Lợi nhuận']);
    expect(docx.vietnameseKept).toBe(true);
    // Running header, footer and page numbers are furniture: they stay out of the body.
    expect(docx.headerInBody).toBe(false);
    expect(docx.footerInBody).toBe(false);
    expect(docx.pageNumberInBody).toBe(false);
    expect(docx.titleCount).toBe(1);
    // Headings keep their reading order.
    expect(docx.headingOrder).toEqual(['Giới thiệu', 'Phạm vi báo cáo', 'Kết luận']);
  }
  // "Giữ bố cục" keeps the two columns as sections; "dễ chỉnh sửa" flows in one section.
  expect(layout.layoutSections).toBe(true);
  expect(editable.sections).toBe(1);

  // Markdown: a pipe table with its separator row, headings at levels 1, 2, 3, 2, no furniture.
  expect(markdown.pipeRows).toBe(4); // header, separator, two data rows
  expect(markdown.separatorRows).toBe(1);
  expect(markdown.tableHeader).toEqual([
    '**Quý**',
    '**Doanh thu**',
    '**Chi phí**',
    '**Lợi nhuận**',
  ]);
  expect(markdown.headingLevels).toEqual([1, 2, 3, 2]);
  expect(markdown.headerInBody).toBe(false);
  expect(markdown.footerInBody).toBe(false);
});
