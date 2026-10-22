use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const MAX_MEMORY_TEXT_CHARS: usize = 32_768;
const MAX_KIND_CHARS: usize = 64;
const MAX_SOURCE_CHARS: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    #[error("memory database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("memory storage error: {0}")]
    Storage(#[from] std::io::Error),
    #[error("invalid memory request: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryItem {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub importance: f64,
    pub created_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_ms: Option<u64>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MemoryWriteRequest {
    pub kind: String,
    pub text: String,
    pub importance: Option<f64>,
    pub expires_ms: Option<u64>,
    pub source: Option<String>,
    pub turn: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MemoryWriteResult {
    pub id: String,
    pub created_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MemoryHit {
    #[serde(flatten)]
    pub item: MemoryItem,
    pub score: f64,
    pub snippet: String,
}

pub struct MemoryStore {
    connection: Mutex<Connection>,
    path: PathBuf,
    next_id: AtomicU64,
}

impl MemoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, MemoryError> {
        let path = path.as_ref().to_path_buf();
        if path != Path::new(":memory:") {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent)?;
            }
        }
        let connection = if path == Path::new(":memory:") {
            Connection::open_in_memory()?
        } else {
            Connection::open(&path)?
        };
        connection.busy_timeout(std::time::Duration::from_secs(3))?;
        connection.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA user_version = 1;

            CREATE TABLE IF NOT EXISTS memory_items (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                text TEXT NOT NULL,
                importance REAL NOT NULL,
                created_ms INTEGER NOT NULL,
                expires_ms INTEGER,
                source TEXT NOT NULL,
                turn_id INTEGER
            );

            CREATE INDEX IF NOT EXISTS memory_items_expiry
                ON memory_items(expires_ms);
            CREATE INDEX IF NOT EXISTS memory_items_recency
                ON memory_items(created_ms DESC);

            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
                text,
                content='memory_items',
                content_rowid='rowid',
                tokenize='trigram'
            );

            CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
                INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
            END;

            CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
                INSERT INTO memory_fts(memory_fts, rowid, text)
                VALUES ('delete', old.rowid, old.text);
            END;

            CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
                INSERT INTO memory_fts(memory_fts, rowid, text)
                VALUES ('delete', old.rowid, old.text);
                INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
            END;
            "#,
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
            path,
            next_id: AtomicU64::new(0),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn write(
        &self,
        request: MemoryWriteRequest,
    ) -> Result<MemoryWriteResult, MemoryError> {
        let kind = validate_label("kind", request.kind, MAX_KIND_CHARS)?;
        let text = request.text.trim().to_owned();
        if text.is_empty() {
            return Err(MemoryError::Invalid("text is empty".into()));
        }
        if text.chars().count() > MAX_MEMORY_TEXT_CHARS {
            return Err(MemoryError::Invalid(format!(
                "text exceeds {MAX_MEMORY_TEXT_CHARS} characters"
            )));
        }
        let source = validate_label(
            "source",
            request.source.unwrap_or_else(|| "hub".into()),
            MAX_SOURCE_CHARS,
        )?;
        let importance = request.importance.unwrap_or(0.5);
        if !importance.is_finite() {
            return Err(MemoryError::Invalid(
                "importance must be a finite number".into(),
            ));
        }
        let importance = importance.clamp(0.0, 1.0);
        let created_ms = epoch_ms();
        if let Some(expires_ms) = request.expires_ms {
            if expires_ms <= created_ms {
                return Err(MemoryError::Invalid(
                    "expires_ms must be in the future".into(),
                ));
            }
        }
        let turn = request
            .turn
            .map(|turn| {
                i64::try_from(turn).map_err(|_| MemoryError::Invalid("turn is too large".into()))
            })
            .transpose()?;
        let expires_ms = request
            .expires_ms
            .map(|value| {
                i64::try_from(value)
                    .map_err(|_| MemoryError::Invalid("expires_ms is too large".into()))
            })
            .transpose()?;
        let id = format!(
            "mem-{}-{created_ms}-{}",
            std::process::id(),
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );

        let connection = self.connection.lock().await;
        connection.execute(
            r#"
            INSERT INTO memory_items
                (id, kind, text, importance, created_ms, expires_ms, source, turn_id)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                id,
                kind,
                text,
                importance,
                i64::try_from(created_ms)
                    .map_err(|_| MemoryError::Invalid("created_ms is too large".into()))?,
                expires_ms,
                source,
                turn
            ],
        )?;
        Ok(MemoryWriteResult { id, created_ms })
    }

    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<MemoryHit>, MemoryError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let limit = i64::try_from(limit.clamp(1, 20)).unwrap_or(20);
        let now = i64::try_from(epoch_ms())
            .map_err(|_| MemoryError::Invalid("current time is too large".into()))?;
        let connection = self.connection.lock().await;

        if query.chars().count() >= 3 {
            let fts_query = quote_fts_query(query);
            let fts_result = {
                let mut statement = connection.prepare(
                    r#"
                    SELECT
                        m.id, m.kind, m.text, m.importance, m.created_ms,
                        m.expires_ms, m.source, m.turn_id,
                        -bm25(memory_fts) AS score,
                        snippet(memory_fts, 0, '', '', '...', 18) AS snippet
                    FROM memory_fts
                    JOIN memory_items m ON m.rowid = memory_fts.rowid
                    WHERE memory_fts MATCH ?1
                      AND (m.expires_ms IS NULL OR m.expires_ms > ?2)
                    ORDER BY score DESC, m.importance DESC, m.created_ms DESC
                    LIMIT ?3
                    "#,
                )?;
                let rows = statement.query_map(params![fts_query, now, limit], map_hit)?;
                rows.collect::<Result<Vec<_>, _>>()
            };
            if let Ok(hits) = fts_result {
                return Ok(hits);
            }
        }

        let pattern = format!("%{}%", escape_like(query));
        let mut statement = connection.prepare(
            r#"
            SELECT
                id, kind, text, importance, created_ms, expires_ms,
                source, turn_id, 0.0 AS score, text AS snippet
            FROM memory_items
            WHERE text LIKE ?1 ESCAPE '\'
              AND (expires_ms IS NULL OR expires_ms > ?2)
            ORDER BY importance DESC, created_ms DESC
            LIMIT ?3
            "#,
        )?;
        let rows = statement.query_map(params![pattern, now, limit], map_hit)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(MemoryError::from)
    }

    pub async fn recent(&self, limit: usize) -> Result<Vec<MemoryHit>, MemoryError> {
        let limit = i64::try_from(limit.clamp(1, 20)).unwrap_or(20);
        let now = i64::try_from(epoch_ms())
            .map_err(|_| MemoryError::Invalid("current time is too large".into()))?;
        let connection = self.connection.lock().await;
        let mut statement = connection.prepare(
            r#"
            SELECT
                id, kind, text, importance, created_ms, expires_ms,
                source, turn_id, 0.0 AS score, text AS snippet
            FROM memory_items
            WHERE expires_ms IS NULL OR expires_ms > ?1
            ORDER BY importance DESC, created_ms DESC
            LIMIT ?2
            "#,
        )?;
        let rows = statement.query_map(params![now, limit], map_hit)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(MemoryError::from)
    }

    pub async fn delete(&self, id: &str) -> Result<bool, MemoryError> {
        if id.trim().is_empty() {
            return Err(MemoryError::Invalid("id is empty".into()));
        }
        let connection = self.connection.lock().await;
        let changed = connection.execute("DELETE FROM memory_items WHERE id = ?1", params![id])?;
        Ok(changed > 0)
    }

    pub async fn get(&self, id: &str) -> Result<Option<MemoryItem>, MemoryError> {
        let connection = self.connection.lock().await;
        connection
            .query_row(
                r#"
                SELECT id, kind, text, importance, created_ms, expires_ms, source, turn_id
                FROM memory_items
                WHERE id = ?1
                "#,
                params![id],
                map_item,
            )
            .optional()
            .map_err(MemoryError::from)
    }

    pub async fn count(&self) -> Result<u64, MemoryError> {
        let connection = self.connection.lock().await;
        let count: i64 =
            connection.query_row("SELECT COUNT(*) FROM memory_items", [], |row| row.get(0))?;
        Ok(count.max(0) as u64)
    }
}

fn validate_label(field: &str, value: String, max_chars: usize) -> Result<String, MemoryError> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(MemoryError::Invalid(format!("{field} is empty")));
    }
    if value.chars().count() > max_chars {
        return Err(MemoryError::Invalid(format!(
            "{field} exceeds {max_chars} characters"
        )));
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err(MemoryError::Invalid(format!(
            "{field} may contain only ASCII letters, numbers, dot, underscore, and hyphen"
        )));
    }
    Ok(value)
}

fn quote_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn escape_like(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn map_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryItem> {
    Ok(MemoryItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        text: row.get(2)?,
        importance: row.get(3)?,
        created_ms: u64_from_sql(row.get::<_, i64>(4)?),
        expires_ms: row.get::<_, Option<i64>>(5)?.map(u64_from_sql),
        source: row.get(6)?,
        turn: row.get::<_, Option<i64>>(7)?.map(u64_from_sql),
    })
}

fn map_hit(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryHit> {
    Ok(MemoryHit {
        item: MemoryItem {
            id: row.get(0)?,
            kind: row.get(1)?,
            text: row.get(2)?,
            importance: row.get(3)?,
            created_ms: u64_from_sql(row.get::<_, i64>(4)?),
            expires_ms: row.get::<_, Option<i64>>(5)?.map(u64_from_sql),
            source: row.get(6)?,
            turn: row.get::<_, Option<i64>>(7)?.map(u64_from_sql),
        },
        score: row.get(8)?,
        snippet: row.get(9)?,
    })
}

fn u64_from_sql(value: i64) -> u64 {
    value.max(0) as u64
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "absolute-solver-memory-{name}-{}-{}.sqlite3",
            std::process::id(),
            epoch_ms()
        ))
    }

    #[tokio::test]
    async fn memory_survives_reopen_and_supports_chinese_search() {
        let path = temp_path("reopen");
        let store = MemoryStore::open(&path).unwrap();
        let written = store
            .write(MemoryWriteRequest {
                kind: "preference".into(),
                text: "用户喜欢在周一晚上喝乌龙茶。".into(),
                importance: Some(0.9),
                expires_ms: None,
                source: Some("test".into()),
                turn: Some(12),
            })
            .await
            .unwrap();
        assert_eq!(store.count().await.unwrap(), 1);
        drop(store);

        let reopened = MemoryStore::open(&path).unwrap();
        let hits = reopened.search("乌龙茶", 5).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].item.id, written.id);
        assert_eq!(hits[0].item.turn, Some(12));
        assert_eq!(reopened.search("茶", 5).await.unwrap().len(), 1);
        assert!(reopened.delete(&written.id).await.unwrap());
        assert!(reopened.search("乌龙茶", 5).await.unwrap().is_empty());
        drop(reopened);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn expired_memories_are_not_returned() {
        let store = MemoryStore::open(":memory:").unwrap();
        store
            .write(MemoryWriteRequest {
                kind: "notice".into(),
                text: "这是一条马上过期的短消息".into(),
                importance: Some(0.2),
                expires_ms: Some(epoch_ms() + 20),
                source: None,
                turn: None,
            })
            .await
            .unwrap();
        assert_eq!(store.search("短消息", 5).await.unwrap().len(), 1);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(store.search("短消息", 5).await.unwrap().is_empty());
        assert!(store.recent(5).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn recent_memories_are_available_when_search_has_no_match() {
        let store = MemoryStore::open(":memory:").unwrap();
        store
            .write(MemoryWriteRequest {
                kind: "conversation".into(),
                text: "用户名叫林舟，喜欢乌龙茶。".into(),
                importance: Some(0.8),
                expires_ms: None,
                source: Some("test".into()),
                turn: Some(3),
            })
            .await
            .unwrap();
        assert!(store.search("完全不相关的词", 5).await.unwrap().is_empty());
        let recent = store.recent(5).await.unwrap();
        assert_eq!(recent.len(), 1);
        assert!(recent[0].item.text.contains("林舟"));
    }

    #[tokio::test]
    async fn memory_validation_rejects_unsafe_labels_and_large_text() {
        let store = MemoryStore::open(":memory:").unwrap();
        let bad_kind = store
            .write(MemoryWriteRequest {
                kind: "bad kind".into(),
                text: "hello".into(),
                importance: None,
                expires_ms: None,
                source: None,
                turn: None,
            })
            .await;
        assert!(bad_kind.is_err());
        let too_large = store
            .write(MemoryWriteRequest {
                kind: "note".into(),
                text: "x".repeat(MAX_MEMORY_TEXT_CHARS + 1),
                importance: None,
                expires_ms: None,
                source: None,
                turn: None,
            })
            .await;
        assert!(too_large.is_err());
    }
}
