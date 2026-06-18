import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Local JSON-backed sheet for dry-run mode and manual testing.
 *
 * The source file is an array of { phone, status, result } objects. Writes go to
 * a sibling `*.local.json` file so the committed sample stays pristine and can be
 * re-run from a clean state.
 */
export class MockSheets {
  constructor({ path }) {
    this.sourcePath = path;
    this.workingPath = path.replace(/\.json$/, '.local.json');
    this.rows = null;
  }

  async _load() {
    const path = existsSync(this.workingPath) ? this.workingPath : this.sourcePath;
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    this.rows = parsed.map((entry, i) => ({
      rowNumber: i + 2,
      phone: String(entry.phone || '').trim(),
      status: String(entry.status || '').trim(),
      result: String(entry.result || '').trim(),
    }));
  }

  async _persist() {
    const out = this.rows.map(({ phone, status, result }) => ({ phone, status, result }));
    await writeFile(this.workingPath, JSON.stringify(out, null, 2));
  }

  async listRows() {
    if (!this.rows) await this._load();
    return this.rows.map((r) => ({ ...r }));
  }

  async updateRow(rowNumber, fields) {
    if (!this.rows) await this._load();
    const row = this.rows.find((r) => r.rowNumber === rowNumber);
    if (!row) return;
    if (fields.status !== undefined) row.status = fields.status;
    if (fields.result !== undefined) row.result = fields.result;
    await this._persist();
  }
}
