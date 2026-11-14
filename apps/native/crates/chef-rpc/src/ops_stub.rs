//! Non-Windows placeholders: the editing core is not integrated on these targets yet.

use std::time::Duration;

use serde_json::Value;

use crate::client::CallError;
use crate::supervisor::Supervisor;

#[derive(Debug, Clone, PartialEq)]
pub enum JobEnd {
    Finished(Value),
    Failed(Value),
    Cancelled,
    TimedOut,
    Stopped,
}

pub fn start(
    _sup: &Supervisor,
    _op_id: &str,
    _session_id: Option<&str>,
    _params: &Value,
) -> Result<String, CallError> {
    Err(CallError::Closed)
}

pub fn wait_job(_sup: &Supervisor, _job_id: &str, _timeout: Duration) -> JobEnd {
    JobEnd::Stopped
}

pub fn cancel(_sup: &Supervisor, _job_id: &str) -> Result<(), CallError> {
    Err(CallError::Closed)
}

pub fn undo(_sup: &Supervisor, _session_id: &str) -> Result<Value, CallError> {
    Err(CallError::Closed)
}

pub fn redo(_sup: &Supervisor, _session_id: &str) -> Result<Value, CallError> {
    Err(CallError::Closed)
}

pub fn save(_sup: &Supervisor, _session_id: &str, _path: Option<&str>) -> Result<Value, CallError> {
    Err(CallError::Closed)
}
