import json, os, sqlite3
from contextlib import contextmanager
from pathlib import Path

def get_default_db_path() -> str:
    env_path = os.getenv('WATTWISE_DB_PATH')
    if env_path:
        p = Path(env_path)
        if not p.is_absolute():
            p = (Path(__file__).resolve().parent.parent / p).resolve()
        return str(p)
    return str((Path(__file__).resolve().parent.parent / 'wattwise.db').resolve())

DB_PATH = get_default_db_path()

@contextmanager
def connection():
    db_file = Path(DB_PATH).resolve()
    db_file.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_file))
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def init_db():
    with connection() as c:
        c.execute('''CREATE TABLE IF NOT EXISTS analyses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            config_json TEXT NOT NULL,
            result_json TEXT NOT NULL,
            csv_text TEXT NOT NULL
        )''')

def save_analysis(filename, config, result, csv_text):
    with connection() as c:
        cur = c.execute(
            'INSERT INTO analyses(filename,config_json,result_json,csv_text) VALUES(?,?,?,?)',
            (filename, json.dumps(config), json.dumps(result), csv_text)
        )
        return cur.lastrowid

def list_analyses(limit=50):
    with connection() as c:
        rows = c.execute(
            'SELECT id,filename,created_at,result_json FROM analyses ORDER BY id DESC LIMIT ?',
            (limit,)
        ).fetchall()
    out = []
    for r in rows:
        result = json.loads(r['result_json'])
        out.append({
            'id': r['id'],
            'filename': r['filename'],
            'created_at': r['created_at'],
            'summary': result.get('summary', {}),
            'what_if': result.get('what_if', {}),
            'bill_details': result.get('bill_details')
        })
    return out

def get_analysis(analysis_id):
    with connection() as c:
        r = c.execute('SELECT * FROM analyses WHERE id=?', (analysis_id,)).fetchone()
    if r is None:
        return None
    return {
        'id': r['id'],
        'filename': r['filename'],
        'created_at': r['created_at'],
        'config': json.loads(r['config_json']),
        'result': json.loads(r['result_json']),
        'csv_text': r['csv_text']
    }

def update_analysis_result(analysis_id, config, result):
    with connection() as c:
        cur = c.execute(
            'UPDATE analyses SET config_json=?,result_json=? WHERE id=?',
            (json.dumps(config), json.dumps(result), analysis_id)
        )
        return cur.rowcount > 0
