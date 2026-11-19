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
    Notification(crate::client::Notification),
}

#[derive(Clone, Default)]
pub struct JobWaiter;

impl JobWaiter {
    pub fn wait_notification(
        &self,
        _job_id: &str,
        _timeout: Duration,
    ) -> Result<Option<crate::client::Notification>, CallError> {
        Err(CallError::Closed)
    }
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

    pub fn subscribe(&self) -> Receiver<Event> {
        let (sender, events) = channel();
        drop(sender);
        events
    }

    pub fn waiter(&self) -> JobWaiter {
        JobWaiter
    }

    pub fn notify_job_started(&self, _job_id: &str, _op_id: &str, _session_id: Option<&str>) {}

    pub fn status(&self) -> CoreStatus {
        CoreStatus::Stopped
    }

    pub fn request(&self, _method: &str, _params: &Value) -> Result<Value, CallError> {
        Err(CallError::Closed)
    }

    pub fn session_opened(&self, _session_id: &str) {}

    pub fn session_closed(&self, _session_id: &str) {}

    pub fn shutdown(&mut self, _grace: Duration) {}
}
