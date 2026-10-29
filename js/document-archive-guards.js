(function attachDocumentArchiveGuards(global) {
    'use strict';

    var LIMITS = Object.freeze({
        fileBytes: 15 * 1024 * 1024,
        expandedBytes: 40 * 1024 * 1024,
        entryBytes: 16 * 1024 * 1024,
        entries: 2000,
        expansionRatio: 100,
    });

    function asBytes(buffer) {
        return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    }

    function isZip(buffer) {
        var bytes = asBytes(buffer);
        return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    }

    // Bound central-directory claims before a parser starts decompressing data.
    // The worker also counts actual expanded bytes: ZIP sizes alone are untrusted.
    function inspectZip(buffer) {
        var bytes = asBytes(buffer);
        if (bytes.length > LIMITS.fileBytes) throw new Error('Document exceeds the 15 MiB preview limit');
        if (bytes.length < 22) throw new Error('Invalid Office ZIP archive');
        var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        var end = -1;
        var lowest = Math.max(0, bytes.length - 65557);
        for (var cursor = bytes.length - 22; cursor >= lowest; cursor--) {
            if (view.getUint32(cursor, true) === 0x06054b50
                && cursor + 22 + view.getUint16(cursor + 20, true) === bytes.length) {
                end = cursor;
                break;
            }
        }
        if (end === -1) throw new Error('Invalid Office ZIP directory');
        var entryCount = view.getUint16(end + 10, true);
        var directorySize = view.getUint32(end + 12, true);
        var directoryOffset = view.getUint32(end + 16, true);
        if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0
            || view.getUint16(end + 8, true) !== entryCount) {
            throw new Error('Multi-volume Office archives are not supported');
        }
        if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
            throw new Error('ZIP64 documents are not supported for browser preview');
        }
        if (entryCount > LIMITS.entries || directoryOffset + directorySize > end) {
            throw new Error('Office archive exceeds the safe directory limit');
        }

        var entries = [];
        var names = Object.create(null);
        var expanded = 0;
        var position = directoryOffset;
        var directoryEnd = directoryOffset + directorySize;
        var decoder = new TextDecoder('utf-8', { fatal: true });
        for (var index = 0; index < entryCount; index++) {
            if (position + 46 > directoryEnd || view.getUint32(position, true) !== 0x02014b50) {
                throw new Error('Invalid Office ZIP entry');
            }
            var flags = view.getUint16(position + 8, true);
            var method = view.getUint16(position + 10, true);
            var compressedSize = view.getUint32(position + 20, true);
            var uncompressedSize = view.getUint32(position + 24, true);
            var nameLength = view.getUint16(position + 28, true);
            var extraLength = view.getUint16(position + 30, true);
            var commentLength = view.getUint16(position + 32, true);
            var localOffset = view.getUint32(position + 42, true);
            var next = position + 46 + nameLength + extraLength + commentLength;
            if (next > directoryEnd || !nameLength || compressedSize === 0xffffffff
                || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
                throw new Error('Invalid or ZIP64 Office entry');
            }
            if ((flags & 1) !== 0 || (method !== 0 && method !== 8)) {
                throw new Error('Encrypted or unsupported Office archive');
            }
            var name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
            if (name.indexOf('\0') !== -1 || name.indexOf('\\') !== -1 || name.charAt(0) === '/'
                || /^[a-z]:/i.test(name) || name.split('/').some(function (part) { return part === '..'; })
                || names[name]) {
                throw new Error('Unsafe or duplicate Office archive path');
            }
            names[name] = true;
            if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50) {
                throw new Error('Invalid Office ZIP local entry');
            }
            var localNameLength = view.getUint16(localOffset + 26, true);
            var localExtraLength = view.getUint16(localOffset + 28, true);
            var payloadStart = localOffset + 30 + localNameLength + localExtraLength;
            if (payloadStart + compressedSize > directoryOffset
                || view.getUint16(localOffset + 8, true) !== method
                || (view.getUint16(localOffset + 6, true) & 1) !== 0
                || decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) !== name) {
                throw new Error('Inconsistent Office ZIP entry');
            }
            expanded += uncompressedSize;
            if (uncompressedSize > LIMITS.entryBytes || expanded > LIMITS.expandedBytes
                || (uncompressedSize > 1024 * 1024 && uncompressedSize > compressedSize * LIMITS.expansionRatio)) {
                throw new Error('Office archive exceeds the safe expansion limit');
            }
            entries.push({ name: name, bytes: uncompressedSize });
            position = next;
        }
        if (position !== directoryEnd) throw new Error('Inconsistent Office ZIP directory size');
        return { entries: entries, expandedBytes: expanded };
    }

    global.DocumentArchiveGuards = { limits: LIMITS, isZip: isZip, inspectZip: inspectZip };
})(typeof globalThis !== 'undefined' ? globalThis : self);
