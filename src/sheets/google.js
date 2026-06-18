import { google } from 'googleapis';

function columnLetter(index) {
  // 0 -> A, 1 -> B, ... 26 -> AA
  let n = index;
  let letter = '';
  do {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letter;
}

/**
 * Google Sheets adapter. Expects a header row (row 1) containing the configured
 * Phone / Status / Result column names (case-insensitive match). Data rows start
 * at row 2.
 */
export class GoogleSheets {
  constructor({ credentialsPath, sheetId, sheetName, columns }) {
    this.credentialsPath = credentialsPath;
    this.sheetId = sheetId;
    this.sheetName = sheetName;
    this.columns = columns;
    this.client = null;
    this.headerIndex = null;
  }

  async init() {
    const auth = new google.auth.GoogleAuth({
      keyFile: this.credentialsPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.client = google.sheets({ version: 'v4', auth });
  }

  _resolveHeader(header) {
    const lower = header.map((h) => String(h || '').trim().toLowerCase());
    const find = (name) => {
      const idx = lower.indexOf(name.toLowerCase());
      if (idx === -1) {
        throw new Error(
          `Column "${name}" not found in the header row of "${this.sheetName}". ` +
            `Found columns: ${header.join(', ')}`
        );
      }
      return idx;
    };
    this.headerIndex = {
      phone: find(this.columns.phone),
      status: find(this.columns.status),
      result: find(this.columns.result),
    };
  }

  async listRows() {
    if (!this.client) await this.init();
    const res = await this.client.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: this.sheetName,
    });
    const values = res.data.values || [];
    if (values.length === 0) return [];

    const [header, ...dataRows] = values;
    this._resolveHeader(header);

    return dataRows.map((cells, i) => ({
      rowNumber: i + 2, // 1-based, plus the header row
      phone: String(cells[this.headerIndex.phone] || '').trim(),
      status: String(cells[this.headerIndex.status] || '').trim(),
      result: String(cells[this.headerIndex.result] || '').trim(),
    }));
  }

  async updateRow(rowNumber, fields) {
    if (!this.client) await this.init();
    if (!this.headerIndex) await this.listRows();

    const data = [];
    if (fields.status !== undefined) {
      data.push({
        range: `${this.sheetName}!${columnLetter(this.headerIndex.status)}${rowNumber}`,
        values: [[fields.status]],
      });
    }
    if (fields.result !== undefined) {
      data.push({
        range: `${this.sheetName}!${columnLetter(this.headerIndex.result)}${rowNumber}`,
        values: [[fields.result]],
      });
    }
    if (data.length === 0) return;

    await this.client.spreadsheets.values.batchUpdate({
      spreadsheetId: this.sheetId,
      requestBody: { valueInputOption: 'RAW', data },
    });
  }
}
