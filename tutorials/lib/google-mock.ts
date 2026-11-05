/**
 * 使い方動画の収録で使う、Google の模擬サーバー。
 * OAuth のトークンと Sheets API（タブ一覧・batchUpdate）だけを受け取り、シートの中身を覚える。
 * 本物の Google には接続しない。import しただけでは起動しない
 * （tutorials:check がシナリオ経由でこのファイルを読み込むため）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const TUTORIAL_SPREADSHEET_ID = "tutorial-spreadsheet";

/**
 * 保存から自動反映までの待ち時間（ミリ秒）。本番は 30 秒だが、動画では短くする。
 * 設定画面は反映待ちの間 5 秒おきに状態を取り直す。
 * ナレーションとゆっくりした操作で字幕の間隔が延びるので、字幕と「反映待ち」の強調が
 * 終わるまで表示が残る長さ（12 秒）にしている。
 * 短すぎると、設定画面を開く前や字幕のあいだに反映が終わって「反映待ち」を映せない。
 */
export const TUTORIAL_SHEETS_DELAY_MS = 12000;

const ACCESS_TOKEN = "tutorial-access-token";

export interface MockCell {
  text: string;
  /** =HYPERLINK("url","text") のときのリンク先 */
  link?: string;
  bold?: boolean;
  fontSize?: number;
  /** 文字色（#rrggbb） */
  color?: string;
  /** 背景色（#rrggbb） */
  background?: string;
}

export interface MockTab {
  sheetId: number;
  title: string;
  index: number;
  rows: MockCell[][];
  /** 列番号 → 幅（px）。指定の無い列は含めない */
  columnWidths: Record<number, number>;
  hiddenColumns: number[];
  frozenRowCount: number;
}

export interface MockSpreadsheet {
  tabs: MockTab[]; // index の昇順
  /** batchUpdate を受けた回数 */
  batchCount: number;
  /** 最後に batchUpdate を受けた時刻（ms）。まだなら null */
  updatedAt: number | null;
}

const HYPERLINK = /^=HYPERLINK\("((?:[^"]|"")*)","((?:[^"]|"")*)"\)$/;

function freshTabs(): MockTab[] {
  return [
    {
      sheetId: 0,
      title: "シート1",
      index: 0,
      rows: [],
      columnWidths: {},
      hiddenColumns: [],
      frozenRowCount: 0,
    },
  ];
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 色は 0〜1。省略された成分は 0 として #rrggbb にする */
function hexChannel(value: unknown): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const byte = Math.round(Math.min(1, Math.max(0, n)) * 255);
  return byte.toString(16).padStart(2, "0");
}

function hexColor(raw: unknown): string {
  const color = asRecord(raw);
  return `#${hexChannel(color?.red)}${hexChannel(color?.green)}${hexChannel(color?.blue)}`;
}

function unescapeQuotes(value: string): string {
  return value.replaceAll('""', '"');
}

/** =HYPERLINK("url","text")。`"` は `""` でエスケープされている。それ以外の数式は null */
function parseHyperlink(formula: string): { link: string; text: string } | null {
  const matched = HYPERLINK.exec(formula);
  if (!matched) return null;
  return { link: unescapeQuotes(matched[1]), text: unescapeQuotes(matched[2]) };
}

function cellFrom(raw: unknown): MockCell {
  const cell: MockCell = { text: "" };
  const record = asRecord(raw);
  if (!record) return cell;
  const value = asRecord(record.userEnteredValue);
  if (value && typeof value.formulaValue === "string") {
    const link = parseHyperlink(value.formulaValue);
    if (link) {
      cell.text = link.text;
      cell.link = link.link;
    } else {
      cell.text = value.formulaValue;
    }
  } else if (value && typeof value.stringValue === "string") {
    cell.text = value.stringValue;
  }
  const format = asRecord(record.userEnteredFormat);
  const textFormat = asRecord(format?.textFormat);
  if (textFormat) {
    if (typeof textFormat.bold === "boolean") cell.bold = textFormat.bold;
    if (typeof textFormat.fontSize === "number") cell.fontSize = textFormat.fontSize;
    if (textFormat.foregroundColor && typeof textFormat.foregroundColor === "object") cell.color = hexColor(textFormat.foregroundColor);
  }
  if (format?.backgroundColor && typeof format.backgroundColor === "object") cell.background = hexColor(format.backgroundColor);
  return cell;
}

function requireTab(tabs: MockTab[], sheetId: unknown): MockTab | string {
  if (typeof sheetId !== "number") return `No grid with id: ${String(sheetId)}`;
  const tab = tabs.find((item) => item.sheetId === sheetId);
  if (!tab) return `No grid with id: ${sheetId}`;
  return tab;
}

function applyAddSheet(tabs: MockTab[], raw: unknown): string | null {
  const properties = asRecord(asRecord(raw)?.properties);
  const sheetId = properties?.sheetId;
  const title = properties?.title;
  const index = properties?.index;
  if (typeof sheetId !== "number" || typeof title !== "string" || typeof index !== "number") return null;
  for (const tab of tabs) {
    if (tab.index >= index) tab.index += 1;
  }
  tabs.push({
    sheetId,
    title,
    index,
    rows: [],
    columnWidths: {},
    hiddenColumns: [],
    frozenRowCount: 0,
  });
  tabs.sort((a, b) => a.index - b.index);
  return null;
}

function applyUpdateProperties(tabs: MockTab[], raw: unknown): string | null {
  const properties = asRecord(asRecord(raw)?.properties);
  const tab = requireTab(tabs, properties?.sheetId);
  if (typeof tab === "string") return tab;
  const grid = asRecord(properties?.gridProperties);
  if (grid && typeof grid.frozenRowCount === "number") tab.frozenRowCount = grid.frozenRowCount;
  if (grid && typeof grid.rowCount === "number") tab.rows = tab.rows.slice(0, Math.max(0, grid.rowCount));
  return null;
}

function cellGrid(raw: unknown): MockCell[][] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const values = asRecord(row)?.values;
    if (!Array.isArray(values)) return [];
    return values.map((value) => cellFrom(value));
  });
}

function writeCells(tab: MockTab, rowIndex: number, columnIndex: number, rows: MockCell[][]) {
  // アプリは (0, 0) からシート全体を書き直す
  if (rowIndex === 0 && columnIndex === 0) {
    tab.rows = rows;
    return;
  }
  for (let r = 0; r < rows.length; r++) {
    const rowAt = rowIndex + r;
    while (tab.rows.length <= rowAt) tab.rows.push([]);
    const line = tab.rows[rowAt];
    const source = rows[r];
    for (let c = 0; c < source.length; c++) {
      const colAt = columnIndex + c;
      while (line.length <= colAt) line.push({ text: "" });
      line[colAt] = source[c];
    }
  }
}

function applyUpdateCells(tabs: MockTab[], raw: unknown): string | null {
  const body = asRecord(raw);
  const start = asRecord(body?.start);
  const tab = requireTab(tabs, start?.sheetId);
  if (typeof tab === "string") return tab;
  const rowIndex = typeof start?.rowIndex === "number" ? start.rowIndex : 0;
  const columnIndex = typeof start?.columnIndex === "number" ? start.columnIndex : 0;
  writeCells(tab, rowIndex, columnIndex, cellGrid(body?.rows));
  return null;
}

function applyUpdateDimensions(tabs: MockTab[], raw: unknown): string | null {
  const body = asRecord(raw);
  const range = asRecord(body?.range);
  const tab = requireTab(tabs, range?.sheetId);
  if (typeof tab === "string") return tab;
  if (range?.dimension !== "COLUMNS") return null;
  const startIndex = range.startIndex;
  const endIndex = range.endIndex;
  if (typeof startIndex !== "number" || typeof endIndex !== "number") return null;
  const properties = asRecord(body?.properties) ?? {};
  for (let col = startIndex; col < endIndex; col++) {
    if (typeof properties.pixelSize === "number") tab.columnWidths[col] = properties.pixelSize;
    if (properties.hiddenByUser === true) {
      if (!tab.hiddenColumns.includes(col)) tab.hiddenColumns.push(col);
    } else if (properties.hiddenByUser === false) {
      tab.hiddenColumns = tab.hiddenColumns.filter((n) => n !== col);
    }
  }
  return null;
}

/** 知っているリクエストだけ適用する。アプリが送らない種類は無視する */
function applyRequest(tabs: MockTab[], request: unknown): string | null {
  if (!request || typeof request !== "object") return null;
  const record = request as Record<string, unknown>;
  if ("addSheet" in record) return applyAddSheet(tabs, record.addSheet);
  if ("updateSheetProperties" in record) return applyUpdateProperties(tabs, record.updateSheetProperties);
  if ("updateCells" in record) return applyUpdateCells(tabs, record.updateCells);
  if ("updateDimensionProperties" in record) return applyUpdateDimensions(tabs, record.updateDimensionProperties);
  return null;
}

function decodeId(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

class GoogleMock {
  private server: Server | null = null;
  private listening: string | null = null;
  private tabs: MockTab[] = [];
  private batchCount = 0;
  private updatedAt: number | null = null;

  constructor() {
    this.reset();
  }

  get origin(): string | null {
    return this.listening;
  }

  /** 127.0.0.1 で待ち受け、`http://localhost:ポート` を返す */
  start(port: number): Promise<string> {
    return this.listen(port);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (!server) return;
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** 作ったばかりのスプレッドシートに戻す（サーバーは止めない） */
  reset(): void {
    this.tabs = freshTabs();
    this.batchCount = 0;
    this.updatedAt = null;
  }

  /** いまのシートのコピー（このあとシートが変わっても、戻した側は変わらない） */
  snapshot(): MockSpreadsheet {
    const copy = structuredClone({
      tabs: this.tabs,
      batchCount: this.batchCount,
      updatedAt: this.updatedAt,
    });
    copy.tabs.sort((a, b) => a.index - b.index);
    return copy;
  }

  private async listen(port: number): Promise<string> {
    if (this.server) await this.stop();
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: "mock failure" });
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (e) {
      server.close();
      throw e;
    }
    this.server = server;
    this.listening = `http://localhost:${port}`;
    return this.listening;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/oauth2/token") {
      await this.handleToken(req, res);
      return;
    }
    const prefix = "/v4/spreadsheets/";
    if (!url.pathname.startsWith(prefix)) {
      sendJson(res, 404, { error: { code: 404, message: "Not found." } });
      return;
    }
    const rest = url.pathname.slice(prefix.length);
    const batch = rest.endsWith(":batchUpdate");
    const encodedId = batch ? rest.slice(0, -":batchUpdate".length) : rest;
    if (!encodedId || encodedId.includes("/")) {
      sendJson(res, 404, { error: { code: 404, message: "Not found." } });
      return;
    }
    if (batch) {
      if (req.method !== "POST") {
        sendJson(res, 404, { error: { code: 404, message: "Not found." } });
        return;
      }
      await this.handleBatch(req, res, encodedId);
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 404, { error: { code: 404, message: "Not found." } });
      return;
    }
    this.handleGet(req, res, encodedId);
  }

  private async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const params = new URLSearchParams(await readBody(req));
    const assertion = params.get("assertion") ?? "";
    const grantType = params.get("grant_type");
    // 署名の検証はしない。形だけ JWT（ピリオドで 3 つ）ならトークンを返す
    if (grantType !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || assertion.split(".").length !== 3) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    sendJson(res, 200, { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "Bearer" });
  }

  private authorized(req: IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${ACCESS_TOKEN}`;
  }

  private spreadsheetId(res: ServerResponse, encodedId: string): string | null {
    const id = decodeId(encodedId);
    if (id === null) {
      sendJson(res, 400, { error: "bad request" });
      return null;
    }
    if (id !== TUTORIAL_SPREADSHEET_ID) {
      sendJson(res, 404, { error: { code: 404, message: "Requested entity was not found." } });
      return null;
    }
    return id;
  }

  private handleGet(req: IncomingMessage, res: ServerResponse, encodedId: string): void {
    if (!this.authorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!this.spreadsheetId(res, encodedId)) return;
    sendJson(res, 200, {
      sheets: this.tabs.map((tab) => ({
        properties: { sheetId: tab.sheetId, title: tab.title, index: tab.index },
      })),
    });
  }

  private async handleBatch(req: IncomingMessage, res: ServerResponse, encodedId: string): Promise<void> {
    if (!this.authorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!this.spreadsheetId(res, encodedId)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    const requests = asRecord(parsed)?.requests;
    if (!Array.isArray(requests)) {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    const error = this.applyBatch(requests);
    if (error) {
      sendJson(res, 400, { error: { code: 400, message: error } });
      return;
    }
    this.batchCount += 1;
    this.updatedAt = Date.now();
    sendJson(res, 200, { spreadsheetId: TUTORIAL_SPREADSHEET_ID, replies: [] });
  }

  /** 1 つでも失敗したら、適用途中の変更は捨てて適用前のままにする */
  private applyBatch(requests: unknown[]): string | null {
    const draft = structuredClone(this.tabs);
    for (const request of requests) {
      const error = applyRequest(draft, request);
      if (error) return error;
    }
    this.tabs = draft;
    return null;
  }
}

export const googleMock = new GoogleMock();
