//! UI-facing undo/redo operations for the native editor slice.
use chef_rpc::{CallError, Supervisor};
use serde_json::Value;

pub fn undo(supervisor: &Supervisor, session_id: &str) -> Result<Value, CallError> {
    chef_rpc::ops::undo(supervisor, session_id)
}

pub fn redo(supervisor: &Supervisor, session_id: &str) -> Result<Value, CallError> {
    chef_rpc::ops::redo(supervisor, session_id)
}
