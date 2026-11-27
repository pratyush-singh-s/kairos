use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("could not create the data folder {path}: {source}")]
    CreateDir {
        path: String,
        source: std::io::Error,
    },

    #[error(
        "this database was written by a newer version of Focus (schema {found}, this app knows up to {supported}); install the latest Focus"
    )]
    NewerSchema { found: i64, supported: i64 },

    #[error("invalid value: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;
