//! Placeholder for non-Windows viewer builds. Core integration is Windows-only for now.

use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use serde_json::Value;

use crate::client::CallError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreStatus {
    Starting,
    Ready,
    Crashed,
    Restarting,
    Stopped,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Status(CoreStatus),
}

pub struct Supervisor {
    events: Receiver<Event>,
}

impl Supervisor {
    #[allow(dead_code)]
    pub fn unavailable() -> Self {
        let (sender, events) = channel();
        drop(sender);
        Self { events }
    }

    pub fn events(&self) -> &Receiver<Event> {
        &self.events
    }

    pub fn request(&self, _method: &str, _params: &Value) -> Result<Value, CallError> {
        Err(CallError::Closed)
    }

    pub fn session_opened(&self, _session_id: &str) {}

    pub fn session_closed(&self, _session_id: &str) {}

    pub fn shutdown(&mut self, _grace: Duration) {}
}
