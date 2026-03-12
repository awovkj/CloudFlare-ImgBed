import Database from 'better-sqlite3';

export class SqliteD1 {
    constructor(dbPath) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
    }

    exec(sql) {
        this.db.exec(sql);
    }

    prepare(sql) {
        return new SqliteD1Statement(this.db, sql);
    }
}

class SqliteD1Statement {
    constructor(db, sql) {
        this._db = db;
        this._sql = sql;
        this._params = [];
    }

    bind(...params) {
        this._params = params.map((param) => {
            if (param === undefined) return null;
            if (typeof param === 'boolean') return param ? 1 : 0;
            return param;
        });
        return this;
    }

    async first(column) {
        const stmt = this._db.prepare(this._sql);
        const row = stmt.get(...this._params);
        if (!row) return null;
        return column ? row[column] : row;
    }

    async all() {
        const stmt = this._db.prepare(this._sql);
        const rows = stmt.all(...this._params);
        return { results: rows };
    }

    async run() {
        const stmt = this._db.prepare(this._sql);
        const result = stmt.run(...this._params);
        return {
            success: true,
            meta: {
                changes: result.changes,
                last_row_id: result.lastInsertRowid
            }
        };
    }
}
