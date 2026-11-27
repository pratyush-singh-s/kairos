//! Local storage for Focus: the SQLite schema, migrations, row IDs and the
//! hybrid logical clock used to order changes between paired PCs.
//! Kept free of Tauri so it can be tested on any machine with `cargo test`.

pub mod activity;
pub mod attachments;
pub mod blocking;
pub mod boards;
pub mod calendar;
pub mod capture;
pub mod clock;
pub mod deadlines;
pub mod dashboard;
pub mod day_plan;
mod error;
pub mod goals;
pub mod ids;
pub mod local;
pub mod notes;
pub mod pc_time;
pub mod phone_block;
pub mod phone_focus;
mod migrations;
pub mod presets;
pub mod reasons;
pub mod review;
pub mod remote;
pub mod schedule;
pub mod sessions;
pub mod spaces;
pub mod stats;
pub mod sync;
pub mod settings;
pub mod tasks;
mod store;

pub use error::StoreError;
pub use store::{Store, StoreStatus};
