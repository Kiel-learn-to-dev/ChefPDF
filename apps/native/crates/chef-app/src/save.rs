//! UI-facing save operations for the native editor slice.
use chef_rpc::{CallError, Supervisor};
use serde_json::Value;

pub fn save(
    supervisor: &Supervisor,
    session_id: &str,
    path: Option<&str>,
) -> Result<Value, CallError> {
    chef_rpc::ops::save(supervisor, session_id, path)
}
