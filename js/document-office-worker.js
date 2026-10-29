'use strict';

importScripts('document-archive-guards.js', 'vendor/jszip-3.10.1.min.js');

var workbookBytes = null;
var sheetNames = [];
var busy = false;
var MAX_ROWS = 300;
var MAX_COLUMNS = 50;
var MAX_SHEETS = 40;
var MAX_CELL_CHARS = 2048;

async function validateExpandedArchive(buffer) {
    if (!DocumentArchiveGuards.isZip(buffer)) return;
    var directory = DocumentArchiveGuards.inspectZip(buffer);
    var zip = await JSZip.loadAsync(buffer);
    var total = 0;
    var xmlTags = 0;
    for (var entry of directory.entries) {
        var file = zip.file(entry.name);
        if (!file) {
            if (entry.name.endsWith('/') && entry.bytes === 0) continue;
            throw new Error('Office archive entry could not be read');
        }
        await new Promise(function (resolve, reject) {
            var actual = 0;
            var isXml = /\.(xml|rels)$/i.test(entry.name);
            var stream = file.internalStream('uint8array');
            stream.on('data', function (chunk) {
                actual += chunk.byteLength;
                total += chunk.byteLength;
                if (isXml) {
                    for (var byte of chunk) if (byte === 0x3c) xmlTags++;
                }
                if (actual > entry.bytes || actual > DocumentArchiveGuards.limits.entryBytes
                    || total > DocumentArchiveGuards.limits.expandedBytes || xmlTags > 300000) {
                    stream.pause();
                    reject(new Error('Office archive expanded beyond its safe limit'));
                }
            }).on('error', reject).on('end', function () {
                if (actual !== entry.bytes) reject(new Error('Inconsistent Office archive expanded size'));
                else resolve();
            }).resume();
        });
    }
}

function readSheet(name) {
    if (sheetNames.indexOf(name) === -1) throw new Error('Unknown worksheet');
    var book = XLSX.read(workbookBytes, {
        type: 'array', sheets: [name], dense: true, sheetRows: MAX_ROWS + 1,
        cellHTML: false, cellFormula: false, cellStyles: false, bookVBA: false,
    });
    var sheet = book.Sheets[name];
    var actualRange = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
    var range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    var lastRow = Math.min(range.e.r, MAX_ROWS - 1);
    var lastColumn = Math.min(range.e.c, MAX_COLUMNS - 1);
    var rows = [];
    var columns = [];
    for (var column = 0; column <= lastColumn; column++) columns.push(XLSX.utils.encode_col(column));
    for (var row = 0; row <= lastRow; row++) {
        var values = [];
        for (var col = 0; col <= lastColumn; col++) {
            var cell = sheet['!data'] ? sheet['!data'][row]?.[col] : sheet[XLSX.utils.encode_cell({ r: row, c: col })];
            var text = cell ? String(cell.w ?? XLSX.utils.format_cell(cell)) : '';
            values.push(text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) + '...' : text);
        }
        rows.push(values);
    }
    return {
        type: 'sheet', sheet: name, sheets: sheetNames, rows: rows, columns: columns,
        limited: actualRange.e.r >= MAX_ROWS || actualRange.e.c >= MAX_COLUMNS,
        rowLimit: MAX_ROWS, columnLimit: MAX_COLUMNS,
    };
}

self.onmessage = async function (event) {
    var message = event.data || {};
    if (busy) return;
    busy = true;
    try {
        if (message.type === 'open') {
            if (!(message.buffer instanceof ArrayBuffer)
                || message.buffer.byteLength > DocumentArchiveGuards.limits.fileBytes) {
                throw new Error('Document exceeds the 15 MiB preview limit');
            }
            await validateExpandedArchive(message.buffer);
            if (message.format === 'docx') {
                if (!DocumentArchiveGuards.isZip(message.buffer)) throw new Error('Invalid DOCX document');
                self.postMessage({ type: 'docx', id: message.id, buffer: message.buffer }, [message.buffer]);
            } else if (message.format === 'sheet') {
                if (!self.XLSX) importScripts('vendor/xlsx-0.20.3.full.min.js');
                workbookBytes = message.buffer;
                var summary = XLSX.read(workbookBytes, { type: 'array', bookSheets: true, bookProps: false });
                sheetNames = summary.SheetNames;
                if (!sheetNames.length || sheetNames.length > MAX_SHEETS) {
                    throw new Error('Workbook must contain between 1 and 40 worksheets');
                }
                self.postMessage(Object.assign({ id: message.id }, readSheet(sheetNames[0])));
            } else {
                throw new Error('Unsupported local document format');
            }
        } else if (message.type === 'sheet' && workbookBytes) {
            self.postMessage(Object.assign({ id: message.id }, readSheet(message.sheet)));
        }
    } catch (error) {
        self.postMessage({ type: 'error', id: message.id, message: error.message || 'Document parsing failed' });
    } finally {
        busy = false;
    }
};
