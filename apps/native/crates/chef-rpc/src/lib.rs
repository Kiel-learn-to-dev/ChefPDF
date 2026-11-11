//! chef-rpc: client JSON-RPC tới lõi Python (TASKS_RUST R3.01, R3.02). Khung dòng ở `framing`, client ở `client`,
//! Job Object và giám sát tiến trình lõi (chỉ Windows) ở `job` và `supervisor`.

pub mod client;
pub mod errors;
pub mod framing;
#[cfg(windows)]
pub mod job;
#[cfg(windows)]
pub mod ops;
#[cfg(windows)]
pub mod supervisor;

pub use client::{CallError, Client, ExitInfo, Notification};
#[cfg(windows)]
pub use supervisor::{CoreCommand, CoreStatus, Event, Supervisor, SupervisorConfig};
