/**
 * D1 数据库操作工具类
 * 优化：缓存 prepared statements，减少重复解析开销
 */
class D1Database {
    constructor(db) {
        this.db = db;
        this._stmtCache = new Map();
    }

    _prepare(sql) {
        if (!this._stmtCache.has(sql)) {
            this._stmtCache.set(sql, this.db.prepare(sql));
        }
        return this._stmtCache.get(sql);
    }
}

// ==================== 文件操作 ====================

/**
 * 保存文件记录 (替代 KV.put)
 */
D1Database.prototype.putFile = function(fileId, value, options) {
    value = value || '';
    options = options || {};
    var metadata = options.metadata || {};
    var fields = this.extractMetadataFields(metadata);
    
    return this._prepare(
        'INSERT OR REPLACE INTO files (id, value, metadata, file_name, file_type, file_size, upload_ip, upload_address, list_type, timestamp, label, directory, channel, channel_name, tg_file_id, tg_chat_id, tg_bot_token, is_chunked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(fileId, value, JSON.stringify(metadata), fields.fileName, fields.fileType, fields.fileSize, fields.uploadIP, fields.uploadAddress, fields.listType, fields.timestamp, fields.label, fields.directory, fields.channel, fields.channelName, fields.tgFileId, fields.tgChatId, fields.tgBotToken, fields.isChunked).run();
};

/**
 * 获取文件记录 (替代 KV.get)
 */
D1Database.prototype.getFile = function(fileId) {
    return this._prepare('SELECT * FROM files WHERE id = ?').bind(fileId).first().then(function(result) {
        if (!result) return null;
        return {
            value: result.value,
            metadata: JSON.parse(result.metadata || '{}')
        };
    });
};

D1Database.prototype.getFileWithMetadata = function(fileId) {
    return this.getFile(fileId);
};

D1Database.prototype.deleteFile = function(fileId) {
    return this._prepare('DELETE FROM files WHERE id = ?').bind(fileId).run();
};

/**
 * 列出文件 (替代 KV.list)
 */
D1Database.prototype.listFiles = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var limit = options.limit || 1000;
    var cursor = options.cursor || null;
    
    var query = 'SELECT id, metadata FROM files';
    var params = [];
    
    if (prefix) {
        query += ' WHERE id LIKE ?';
        params.push(prefix + '%');
    }
    
    if (cursor) {
        query += prefix ? ' AND' : ' WHERE';
        query += ' id > ?';
        params.push(cursor);
    }
    
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);
    
    var stmt = this._prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        var results = response.results || [];
        var hasMore = results.length > limit;
        if (hasMore) results.pop();

        return {
            keys: results.map(function(row) {
                return { name: row.id, metadata: JSON.parse(row.metadata || '{}') };
            }),
            cursor: hasMore && results.length > 0 ? results[results.length - 1].id : null,
            list_complete: !hasMore
        };
    });
};

// ==================== 设置操作 ====================

/**
 * 保存设置 (替代 KV.put)
 */
D1Database.prototype.putSetting = function(key, value, category) {
    if (!category && key.startsWith('manage@sysConfig@')) {
        category = key.split('@')[2];
    }
    return this._prepare('INSERT OR REPLACE INTO settings (key, value, category) VALUES (?, ?, ?)').bind(key, value, category).run();
};

D1Database.prototype.getSetting = function(key) {
    return this._prepare('SELECT value FROM settings WHERE key = ?').bind(key).first().then(function(result) {
        return result ? result.value : null;
    });
};

D1Database.prototype.deleteSetting = function(key) {
    return this._prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
};

D1Database.prototype.listSettings = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var limit = options.limit || 1000;
    
    var query = 'SELECT key, value FROM settings';
    var params = [];
    
    if (prefix) {
        query += ' WHERE key LIKE ?';
        params.push(prefix + '%');
    }
    
    query += ' ORDER BY key LIMIT ?';
    params.push(limit);
    
    var stmt = this._prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        return {
            keys: (response.results || []).map(function(row) {
                return { name: row.key, value: row.value };
            })
        };
    });
};

// ==================== 索引操作 ====================

/**
 * 保存索引操作记录
 */
D1Database.prototype.putIndexOperation = function(operationId, operation) {
    return this._prepare('INSERT OR REPLACE INTO index_operations (id, type, timestamp, data) VALUES (?, ?, ?, ?)').bind(operationId, operation.type, operation.timestamp, JSON.stringify(operation.data)).run();
};

D1Database.prototype.getIndexOperation = function(operationId) {
    return this._prepare('SELECT * FROM index_operations WHERE id = ?').bind(operationId).first().then(function(result) {
        if (!result) return null;
        return {
            type: result.type,
            timestamp: result.timestamp,
            data: JSON.parse(result.data)
        };
    });
};

D1Database.prototype.deleteIndexOperation = function(operationId) {
    return this._prepare('DELETE FROM index_operations WHERE id = ?').bind(operationId).run();
};

D1Database.prototype.listIndexOperations = function(options) {
    options = options || {};
    var limit = options.limit || 1000;
    var processed = options.processed;
    
    var query = 'SELECT * FROM index_operations';
    var params = [];
    
    if (processed !== null && processed !== undefined) {
        query += ' WHERE processed = ?';
        params.push(processed);
    }
    
    query += ' ORDER BY timestamp LIMIT ?';
    params.push(limit);
    
    var stmt = this._prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        return (response.results || []).map(function(row) {
            return {
                id: row.id,
                type: row.type,
                timestamp: row.timestamp,
                data: JSON.parse(row.data),
                processed: row.processed
            };
        });
    });
};

// ==================== 工具方法 ====================

/**
 * 从metadata中提取字段用于索引
 */
D1Database.prototype.extractMetadataFields = function(metadata) {
    return {
        fileName: metadata.FileName || null,
        fileType: metadata.FileType || null,
        fileSize: metadata.FileSize || null,
        uploadIP: metadata.UploadIP || null,
        uploadAddress: metadata.UploadAddress || null,
        listType: metadata.ListType || null,
        timestamp: metadata.TimeStamp || null,
        label: metadata.Label || null,
        directory: metadata.Directory || null,
        channel: metadata.Channel || null,
        channelName: metadata.ChannelName || null,
        tgFileId: metadata.TgFileId || null,
        tgChatId: metadata.TgChatId || null,
        tgBotToken: metadata.TgBotToken || null,
        isChunked: metadata.IsChunked || false
    };
};

// ==================== 通用方法 ====================

/**
 * 通用的put方法，根据key类型自动选择存储位置
 */
D1Database.prototype.put = function(key, value, options) {
    options = options || {};

    if (key.startsWith('manage@sysConfig@')) {
        return this.putSetting(key, value);
    } else if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        var operation = JSON.parse(value);
        return this.putIndexOperation(operationId, operation);
    } else {
        return this.putFile(key, value, options);
    }
};

/**
 * 通用的get方法，根据key类型自动选择获取位置
 */
D1Database.prototype.get = function(key) {
    var self = this;

    if (key.startsWith('manage@sysConfig@')) {
        return this.getSetting(key);
    } else if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        return this.getIndexOperation(operationId).then(function(operation) {
            return operation ? JSON.stringify(operation) : null;
        });
    } else {
        return this.getFile(key).then(function(file) {
            return file ? file.value : null;
        });
    }
};

/**
 * 通用的getWithMetadata方法
 */
D1Database.prototype.getWithMetadata = function(key) {
    var self = this;

    if (key.startsWith('manage@sysConfig@')) {
        return this.getSetting(key).then(function(value) {
            return value ? { value: value, metadata: {} } : null;
        });
    } else {
        return this.getFileWithMetadata(key);
    }
};

/**
 * 通用的delete方法
 */
D1Database.prototype.delete = function(key) {
    if (key.startsWith('manage@sysConfig@')) {
        return this.deleteSetting(key);
    } else if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        return this.deleteIndexOperation(operationId);
    } else {
        return this.deleteFile(key);
    }
};

/**
 * 通用的list方法
 */
D1Database.prototype.list = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var self = this;

    if (prefix.startsWith('manage@sysConfig@')) {
        return this.listSettings(options);
    } else if (prefix.startsWith('manage@index@operation_')) {
        return this.listIndexOperations(options).then(function(operations) {
            var keys = operations.map(function(op) {
                return {
                    name: 'manage@index@operation_' + op.id
                };
            });
            return { keys: keys };
        });
    } else {
        return this.listFiles(options);
    }
};

// 导出构造函数
export { D1Database };
